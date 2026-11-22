#!/usr/bin/node
import { execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EXECUTION_POLICY, safeExecutionId, executionCommandMetadata, buildExecutionStartArgs, buildExecutionIdentityCheckScript, buildExecutionCancelScript, createExecutionRecord, executionRetentionActions, assertExecutionLogQuota, executionLogReadWindow } from './executions.mjs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SOCKET = '/run/vps-sandbox-runtime.sock';
const DATA_DIR = '/var/lib/vps-sandbox/workloads';
const EXECUTION_RECORDS_DIR = '/var/lib/vps-sandbox/executions';
const EXECUTION_LOG_ROOT = '/var/lib/vps-sandbox/execution-logs';
const PODMAN = '/usr/bin/podman';
const CGROUP_PARENT = '/system.slice/vps-sandbox-runtime.service';
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_SANDBOX_CONCURRENCY = 4;
const MAX_SANDBOX_FILE_BYTES = 2 * 1024 * 1024;
let activeSandboxOperations = 0;
const activeSandboxWorkloads = new Map();
const mutatingWorkloads = new Set();
const activeExecutionStarts = new Set();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_DIGEST = /^[a-z0-9][a-z0-9._/:+-]{0,180}@sha256:[a-f0-9]{64}$/i;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9._-]{1,199}$/i;
const OPERATIONS = new Set(['image.inspect', 'image.pull', 'container.create', 'container.start', 'container.inspect', 'container.list', 'container.stop', 'container.remove', 'container.exec', 'container.logs', 'sandbox.exec', 'sandbox.fs.list', 'sandbox.fs.read', 'sandbox.fs.write', 'sandbox.execution.start', 'sandbox.execution.status', 'sandbox.execution.logs', 'sandbox.execution.cancel', 'sandbox.execution.list']);
let operationQueue = Promise.resolve();
const ACTIVE_STATES = new Set(['creating', 'created', 'starting', 'running', 'stopping', 'stopped', 'removing', 'error']);

function assert(condition, message) { if (!condition) throw new Error(message); }
function safeId(value) { assert(typeof value === 'string' && UUID.test(value), 'Invalid workload ID'); return value.toLowerCase(); }
export function safeImage(value) {
  assert(typeof value === 'string' && IMAGE_DIGEST.test(value), 'Image must be pinned by sha256 digest');
  const approved = (process.env.VPS_SANDBOX_ALLOWED_IMAGES ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  assert(approved.includes(value), 'Image digest is not present in the administrator-approved runtime image allowlist');
  return value;
}
function safeRepositoryId(value) { assert(typeof value === 'string' && REPOSITORY_ID.test(value), 'Invalid repository ID'); return value; }
function safeArgv(value) {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 64, 'Command must be a non-empty argument array');
  for (const arg of value) assert(typeof arg === 'string' && arg.length > 0 && arg.length <= 4096 && !arg.includes('\0'), 'Invalid command argument');
  return value;
}
function safeResources(value = {}) {
  const cpuMilli = value.cpuMilli ?? 1000;
  const memoryMiB = value.memoryMiB ?? 1024;
  const pids = value.pids ?? 128;
  assert(Number.isInteger(cpuMilli) && cpuMilli >= 100 && cpuMilli <= 2000, 'cpuMilli must be between 100 and 2000');
  assert(Number.isInteger(memoryMiB) && memoryMiB >= 128 && memoryMiB <= 4096, 'memoryMiB must be between 128 and 4096');
  assert(Number.isInteger(pids) && pids >= 32 && pids <= 512, 'pids must be between 32 and 512');
  return { cpuMilli, memoryMiB, pids };
}
export function expectedTaskWorkspacePath(root, repositoryId, worktreeId) {
  safeRepositoryId(repositoryId);
  safeId(worktreeId);
  assert(root === '/srv/vps-mcp-workspaces' || root === '/var/lib/vps-mcp/task-workspaces/worktrees', 'Workspace root is not approved');
  return path.join(root, repositoryId, worktreeId);
}
export function parseRuntimeRequest(raw) {
  assert(Buffer.byteLength(raw, 'utf8') <= MAX_REQUEST_BYTES, 'Request is too large');
  let request;
  try { request = JSON.parse(raw); } catch { throw new Error('Request must be valid JSON'); }
  assert(request && typeof request === 'object' && !Array.isArray(request), 'Request must be an object');
  assert(typeof request.operation === 'string' && OPERATIONS.has(request.operation), 'Unsupported runtime operation');
  const allowed = {
    'image.inspect': ['operation', 'image'],
    'image.pull': ['operation', 'image'],
    'container.create': ['operation', 'workloadId', 'workloadType', 'repositoryId', 'worktreeId', 'image', 'resources', 'network', 'readOnlyRootfs', 'workspacePath', 'workspaceAccess', 'command'],
    'container.start': ['operation', 'workloadId', 'expectedWorkloadType'],
    'container.inspect': ['operation', 'workloadId'],
    'container.list': ['operation'],
    'container.stop': ['operation', 'workloadId', 'expectedWorkloadType'],
    'container.remove': ['operation', 'workloadId', 'expectedWorkloadType'],
    'container.exec': ['operation', 'workloadId', 'command', 'timeoutMs'],
    'container.logs': ['operation', 'workloadId'],
    'sandbox.exec': ['operation', 'sandboxId', 'command', 'cwd', 'timeoutMs', 'maxOutputBytes', 'env'],
    'sandbox.fs.list': ['operation', 'sandboxId', 'path'],
    'sandbox.fs.read': ['operation', 'sandboxId', 'path'],
    'sandbox.fs.write': ['operation', 'sandboxId', 'path', 'content'],
    'sandbox.execution.start': ['operation', 'sandboxId', 'command', 'cwd', 'timeoutMs'],
    'sandbox.execution.status': ['operation', 'sandboxId', 'executionId'],
    'sandbox.execution.logs': ['operation', 'sandboxId', 'executionId', 'offset', 'maxBytes'],
    'sandbox.execution.cancel': ['operation', 'sandboxId', 'executionId'],
    'sandbox.execution.list': ['operation', 'sandboxId'],
  }[request.operation];
  assert(Object.keys(request).every((key) => allowed.includes(key)), 'Request contains unsupported properties');
  if (request.operation.startsWith('sandbox.')) {
    safeId(request.sandboxId);
    if (request.operation === 'sandbox.exec') {
      safeArgv(request.command);
      if (request.timeoutMs !== undefined) assert(Number.isInteger(request.timeoutMs) && request.timeoutMs >= 1000 && request.timeoutMs <= MAX_TIMEOUT_MS, 'timeoutMs must be between 1000 and 120000');
      if (request.maxOutputBytes !== undefined) assert(Number.isInteger(request.maxOutputBytes) && request.maxOutputBytes >= 1024 && request.maxOutputBytes <= 1_048_576, 'maxOutputBytes must be between 1024 and 1048576');
      if (request.cwd !== undefined) validateWorkspaceRelativePath(request.cwd, true);
      const allowedEnv = new Set(['LANG', 'LC_ALL', 'TZ', 'CI', 'NODE_ENV', 'TERM']);
      assert(request.env === undefined || (request.env && typeof request.env === 'object' && !Array.isArray(request.env) && Object.entries(request.env).every(([key, value]) => allowedEnv.has(key) && typeof value === 'string' && value.length <= 256 && !value.includes('\0'))), 'Environment contains unsupported or invalid variables');
    } else if (request.operation.startsWith('sandbox.fs.')) {
      validateWorkspaceRelativePath(request.path, request.operation === 'sandbox.fs.list');
      if (request.operation === 'sandbox.fs.write') assert(typeof request.content === 'string' && Buffer.byteLength(request.content, 'utf8') <= 1024 * 1024, 'File content exceeds the 1 MiB write limit');
    } else if (request.operation === 'sandbox.execution.start') {
      safeArgv(request.command);
      if (request.cwd !== undefined) validateWorkspaceRelativePath(request.cwd, true);
      if (request.timeoutMs !== undefined) assert(Number.isInteger(request.timeoutMs) && request.timeoutMs >= 1000 && request.timeoutMs <= EXECUTION_POLICY.maxTimeoutMs, 'timeoutMs is outside the allowed range');
    } else if (request.operation === 'sandbox.execution.status' || request.operation === 'sandbox.execution.logs' || request.operation === 'sandbox.execution.cancel') {
      safeExecutionId(request.executionId);
      if (request.operation === 'sandbox.execution.logs') {
        if (request.offset !== undefined) assert(Number.isSafeInteger(request.offset) && request.offset >= 0, 'offset must be a non-negative safe integer');
        if (request.maxBytes !== undefined) assert(Number.isInteger(request.maxBytes) && request.maxBytes >= 1024 && request.maxBytes <= 262144, 'maxBytes must be between 1024 and 262144');
      }
    }
  }
  return request;
}
function validateWorkspaceRelativePath(value, allowEmpty = false) {
  assert(typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && !value.startsWith('/') && !value.includes('\\'), 'Path must be workspace-relative and no longer than 4096 characters');
  if (!value && allowEmpty) return;
  const parts = value.split('/');
  assert(value && parts.every((part) => part && part !== '.' && part !== '..'), 'Path contains an unsafe component');
}
async function ensureDataDir() { await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 }); }
function recordPath(id) { return path.join(DATA_DIR, safeId(id), 'record.json'); }
function executionLogDirectory(sandboxId) { return path.join(EXECUTION_LOG_ROOT, safeId(sandboxId)); }
function executionRecordDirectory(sandboxId, executionId) { return path.join(EXECUTION_RECORDS_DIR, safeId(sandboxId), safeExecutionId(executionId)); }
function executionRecordPath(sandboxId, executionId) { return path.join(executionRecordDirectory(sandboxId, executionId), 'record.json'); }
async function ensureExecutionLogDirectory(sandboxId) {
  const directory = executionLogDirectory(sandboxId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const stat = await fs.lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Execution log directory must be a real directory');
  assert(await fs.realpath(directory) === directory, 'Execution log directory must be canonical');
  return { path: directory, destination: '/run/vps-mcp-executions' };
}
async function writeExecutionRecord(record) {
  const directory = executionRecordDirectory(record.sandboxId, record.id);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, '.record-' + randomUUID() + '.tmp');
  await fs.writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, executionRecordPath(record.sandboxId, record.id));
}
async function readExecutionRecord(sandboxId, executionId) {
  const record = JSON.parse(await fs.readFile(executionRecordPath(sandboxId, executionId), 'utf8'));
  assert(record.id === safeExecutionId(executionId) && record.sandboxId === safeId(sandboxId), 'Execution record identity mismatch');
  return record;
}
async function listExecutionRecords(sandboxId) {
  const directory = path.join(EXECUTION_RECORDS_DIR, safeId(sandboxId));
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    try { records.push(await readExecutionRecord(sandboxId, entry.name)); } catch { /* retain corrupt records for operator review */ }
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
async function sumRegularFileBytes(directory) {
  let total = 0;
  let visited = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const entry of entries) {
      visited += 1;
      assert(visited <= 100_000, 'SANDBOX_EXECUTION_LOG_QUOTA: execution log directory contains too many entries');
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        const stat = await fs.lstat(file);
        if (stat.isFile() && !stat.isSymbolicLink()) total += stat.size;
      }
    }
  }
  return total;
}

async function pruneExecutionRetention(sandboxId) {
  const now = Date.now();
  for (const record of await listExecutionRecords(sandboxId)) {
    const retention = executionRetentionActions(record, now);
    if (!retention.expireLogs && !retention.deleteRecord) continue;
    const logPath = path.join(executionLogDirectory(sandboxId), record.logFile);
    if (retention.expireLogs && !record.logsExpired) {
      await fs.rm(logPath, { force: true });
      await fs.rm(path.join(executionLogDirectory(sandboxId), record.id + '.fifo'), { force: true });
      await fs.rm(path.join(executionLogDirectory(sandboxId), record.id + '.cancel'), { force: true });
      record.logsExpired = true;
      record.updatedAt = new Date().toISOString();
      await writeExecutionRecord(record);
    }
    if (retention.deleteRecord) {
      const paths = executionLogPaths(sandboxId, record.id);
      for (const file of Object.values(paths)) await fs.rm(file, { force: true });
      await fs.rm(path.join(executionLogDirectory(sandboxId), record.id + '.fifo'), { force: true });
      await fs.rm(path.join(executionLogDirectory(sandboxId), record.id + '.cancel'), { force: true });
      await fs.rm(executionRecordDirectory(sandboxId, record.id), { recursive: true, force: true });
    }
  }
}
async function writeRecord(record) {
  const destination = recordPath(record.id);
  const directory = path.dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.record-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, destination);
}
async function readRecord(id) {
  const record = JSON.parse(await fs.readFile(recordPath(id), 'utf8'));
  assert(record.id === safeId(id), 'Workload record identity mismatch');
  return record;
}
async function resolveRuntimeId(record) {
  if (record.runtimeId) return record.runtimeId;
  try {
    const result = await runPodman(['inspect', '--format', '{{.Id}}', `vps-wl-${record.id}`]);
    const id = result.stdout.trim();
    return /^[a-f0-9]{12,64}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}
function commandFingerprint(command) {
  return createHash('sha256').update(JSON.stringify(command ?? null)).digest('hex');
}
async function runPodman(args, timeout = DEFAULT_TIMEOUT_MS, maxBuffer = MAX_RESPONSE_BYTES) {
  const { stdout, stderr } = await execFileAsync(PODMAN, ['--cgroup-manager=cgroupfs', ...args], {
    encoding: 'utf8', timeout, maxBuffer,
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/var/lib/vps-sandbox',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? '',
    },
  });
  return { stdout: stdout ?? '', stderr: stderr ?? '' };
}
export function assertWorkloadTypeMatch(record, expectedWorkloadType) {
  assert(expectedWorkloadType === record.workloadType, 'Workload type mismatch; refusing cross-lifecycle operation');
}
export function buildContainerCreateArgs({ id, workloadType, repositoryId, worktreeId, image, resources, workspaceMount, executionMount, command }) {
  assert(workloadType !== 'task' || (executionMount?.destination === '/run/vps-mcp-executions' && path.isAbsolute(executionMount.path)), 'Task workloads require a dedicated execution log mount');
  assert(workloadType !== 'project-service' || executionMount === undefined || executionMount === null, 'Project-service workloads must not receive task execution mounts');
  return [
    'create', '--pull=never', '--cgroup-parent', CGROUP_PARENT, '--name', `vps-wl-${id}`,
    ...labels(id, workloadType, repositoryId, worktreeId),
    '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit', String(resources.pids),
    '--memory', `${resources.memoryMiB}m`, '--cpus', String(resources.cpuMilli / 1000),
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
    ...(workspaceMount ? ['--mount', `type=bind,src=${workspaceMount.path},dst=/workspace,${workspaceMount.access === 'read-only' ? 'ro' : 'rw'}`] : []),
    ...(executionMount ? ['--mount', `type=bind,src=${executionMount.path},dst=/run/vps-mcp-executions,rw`] : []),
    image,
    ...(command === undefined ? [] : safeArgv(command)),
  ];
}
function labels(id, type, repositoryId, worktreeId) {
  return [
    '--label', `io.cr8or.vps-mcp.workload=${id}`,
    '--label', `io.cr8or.vps-mcp.type=${type}`,
    '--label', `io.cr8or.vps-mcp.repository=${repositoryId}`,
    ...(worktreeId ? ['--label', `io.cr8or.vps-mcp.worktree=${worktreeId}`] : []),
  ];
}
async function imageOperation(request) {
  const image = safeImage(request.image);
  if (request.operation === 'image.pull') {
    const result = await runPodman(['pull', '--quiet', image], 120_000);
    return { image, pulled: true, output: result.stdout.trim() };
  }
  const result = await runPodman(['image', 'inspect', '--format', '{{.Id}}', image]);
  return { image, imageId: result.stdout.trim() };
}
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function resolveWorkspaceMount(workspacePath, access, repositoryId, worktreeId) {
  assert(typeof workspacePath === 'string' && path.isAbsolute(workspacePath), 'Workspace path must be absolute');
  assert(access === 'read-only' || access === 'read-write', 'Workspace access must be read-only or read-write');
  assert(!workspacePath.includes(','), 'Workspace path cannot contain commas');
  assert(typeof repositoryId === 'string' && typeof worktreeId === 'string', 'Task workspace mounts require repository and worktree identities');
  const configuredRoots = (process.env.VPS_SANDBOX_ALLOWED_WORKSPACE_ROOTS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  assert(configuredRoots.length > 0, 'No workspace mount roots are configured for the runtime identity');
  const approvedRoots = configuredRoots.filter((root) => root === '/srv/vps-mcp-workspaces' || root === '/var/lib/vps-mcp/task-workspaces/worktrees');
  assert(approvedRoots.length === configuredRoots.length, 'Workspace roots must be explicitly approved worktree directories');
  const expectedPaths = approvedRoots.map((root) => expectedTaskWorkspacePath(root, repositoryId, worktreeId));
  assert(expectedPaths.includes(path.resolve(workspacePath)), 'Workspace path does not match the registered repository/worktree identity');
  const stat = await fs.lstat(workspacePath);
  assert(!stat.isSymbolicLink() && stat.isDirectory(), 'Workspace mount target must be a real managed directory');
  const target = await fs.realpath(workspacePath);
  const roots = await Promise.all(approvedRoots.map((root) => fs.realpath(root)));
  assert(roots.some((root) => isWithin(root, target)), 'Workspace mount path is outside the configured worktree roots');
  return { path: target, access, destination: '/workspace' };
}
async function createWorkload(request) {
  const id = safeId(request.workloadId);
  const workloadType = request.workloadType;
  assert(workloadType === 'task' || workloadType === 'project-service', 'Invalid workload type');
  const repositoryId = safeRepositoryId(request.repositoryId);
  const worktreeId = request.worktreeId === undefined ? undefined : safeId(request.worktreeId);
  const image = safeImage(request.image);
  const resources = safeResources(request.resources);
  if (workloadType === 'task') {
    assert(request.worktreeId, 'Task workloads require a managed worktree ID');
    assert(request.workspacePath, 'Task workloads require their assigned workspace path');
  } else {
    assert(request.workspacePath === undefined && request.workspaceAccess === undefined, 'Project-service mounts are provisioned by the project environment manager');
  }
  const workspaceMount = request.workspacePath === undefined ? null : await resolveWorkspaceMount(request.workspacePath, request.workspaceAccess ?? 'read-only', repositoryId, worktreeId);
  const executionMount = workloadType === 'task' ? await ensureExecutionLogDirectory(id) : null;
  assert(request.network === undefined || request.network === 'none', 'Only network=none is supported by this runtime adapter');
  assert(request.readOnlyRootfs === undefined || request.readOnlyRootfs === true, 'Container root filesystem must be read-only');
  const fingerprint = commandFingerprint(request.command);
  const existing = await fs.readFile(recordPath(id), 'utf8').then((raw) => JSON.parse(raw)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) {
    assert(
      existing.repositoryId === repositoryId &&
      existing.workloadType === workloadType &&
      existing.image === image &&
      existing.worktreeId === worktreeId &&
      JSON.stringify(existing.workspaceMount ?? null) === JSON.stringify(workspaceMount) &&
      JSON.stringify(existing.executionMount ?? null) === JSON.stringify(executionMount) &&
      JSON.stringify(existing.resources) === JSON.stringify(resources) &&
      existing.commandFingerprint === fingerprint,
      'Workload ID is already registered with different immutable attributes',
    );
    return { ...existing, reused: true };
  }

  const record = {
    id, workloadType, repositoryId, ...(worktreeId ? { worktreeId } : {}),
    image, imageDigest: image.slice(image.lastIndexOf('@') + 1),
    runtimeId: null, workspaceMount, executionMount, resources, network: 'none', commandFingerprint: fingerprint,
    status: 'creating', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await writeRecord(record);
  try {
    const args = buildContainerCreateArgs({
      id, workloadType, repositoryId, worktreeId, image, resources, workspaceMount, executionMount, command: request.command,
    });
    const result = await runPodman(args, 120_000);
    const runtimeId = result.stdout.trim().split(/\s+/)[0];
    assert(/^[a-f0-9]{12,64}$/i.test(runtimeId ?? ''), 'Podman returned an invalid container ID');
    const completed = { ...record, runtimeId, status: 'created', updatedAt: new Date().toISOString() };
    await writeRecord(completed);
    return completed;
  } catch (error) {
    const failed = { ...record, status: 'error', error: error instanceof Error ? error.message.slice(0, 500) : 'Runtime create failed', updatedAt: new Date().toISOString() };
    await writeRecord(failed);
    throw error;
  }
}
async function mutate(request, action) {
  const record = await readRecord(request.workloadId);
  assertWorkloadTypeMatch(record, request.expectedWorkloadType);
  assert(ACTIVE_STATES.has(record.status), 'Workload is not in a mutable lifecycle state');
  const runtimeId = await resolveRuntimeId(record);
  if (!runtimeId) {
    const missing = { ...record, status: 'unknown', updatedAt: new Date().toISOString() };
    await writeRecord(missing);
    throw new Error('Managed runtime container is missing; workload record retained for operator review');
  }
  const recovered = runtimeId === record.runtimeId ? record : { ...record, runtimeId, updatedAt: new Date().toISOString() };
  if (recovered !== record) await writeRecord(recovered);
  const current = await runPodman(['inspect', '--format', '{{.State.Status}}', runtimeId]).then((value) => value.stdout.trim()).catch(() => 'missing');
  if (request.operation === 'container.start' && current === 'running') {
    const running = { ...recovered, status: 'running', updatedAt: new Date().toISOString() };
    await writeRecord(running);
    return { workload: running, output: '' };
  }
  if (request.operation === 'container.stop' && current !== 'running') {
    if (recovered.workloadType === 'task' && current !== 'missing') await markActiveExecutionsInterrupted(recovered.id, 'sandbox_stopped');
    const status = current === 'missing' ? 'unknown' : current === 'created' ? 'created' : 'stopped';
    const stopped = { ...recovered, status, updatedAt: new Date().toISOString() };
    await writeRecord(stopped);
    return { workload: stopped, output: '' };
  }
  assert(current !== 'missing', 'Managed runtime container no longer exists; inspect and reconcile before mutation');
  const intentStatus = request.operation === 'container.start' ? 'starting' : 'stopping';
  if (request.operation === 'container.stop' && recovered.workloadType === 'task') await cancelActiveSandboxExecutions(recovered.id, 'sandbox_stopped');
  await writeRecord({ ...recovered, status: intentStatus, updatedAt: new Date().toISOString() });
  const result = await action(recovered);
  if (request.operation === 'container.stop' && recovered.workloadType === 'task') await markActiveExecutionsInterrupted(recovered.id, 'sandbox_stopped');
  const status = request.operation === 'container.start' ? 'running'
    : request.operation === 'container.stop' ? 'stopped'
    : request.operation === 'container.remove' ? 'removed' : record.status;
  const updated = { ...recovered, status, updatedAt: new Date().toISOString() };
  await writeRecord(updated);
  return { workload: updated, output: result.stdout.trim() };
}
export function assertTaskSandboxWorkload(record) {
  assert(record?.workloadType === 'task', 'Sandbox tools are available only for task workloads');
}

async function taskSandboxRecord(sandboxId) {
  const record = await readRecord(sandboxId);
  assertTaskSandboxWorkload(record);
  assert(record.status === 'running', 'Task sandbox is not running');
  assert(record.runtimeId && record.workspaceMount?.destination === '/workspace', 'Task sandbox has no managed workspace mount');
  assert(record.workspaceMount.access === 'read-only' || record.workspaceMount.access === 'read-write', 'Task sandbox workspace access mode is invalid');
  assert(record.worktreeId && UUID.test(record.worktreeId), 'Task sandbox is missing its managed worktree identity');
  const configuredRoots = (process.env.VPS_SANDBOX_ALLOWED_WORKSPACE_ROOTS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const expected = configuredRoots.map((root) => expectedTaskWorkspacePath(root, record.repositoryId, record.worktreeId));
  const workspace = record.workspaceMount.path;
  assert(expected.includes(path.resolve(workspace)), 'Task sandbox workspace does not match its managed repository/worktree identity');
  const runtimeId = await resolveRuntimeId(record);
  assert(runtimeId, 'Task sandbox runtime container is missing');
  const runtimeState = await runPodman(['inspect', '--format', '{{.State.Status}}', runtimeId]).then((value) => value.stdout.trim()).catch(() => 'missing');
  assert(runtimeState === 'running', 'Task sandbox runtime container is not running');
  const stat = await fs.lstat(workspace);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Managed workspace is not a real directory');
  const realWorkspace = await fs.realpath(workspace);
  assert(realWorkspace === workspace, 'Managed workspace path is not canonical');
  return { record, runtimeId };
}

function shellQuote(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }

export function buildSandboxFilesystemScript(operation, workspaceRoot = '/workspace') {
  const root = shellQuote(workspaceRoot);
  if (operation === 'sandbox.fs.list') return String.raw`
set -eu
root=${root}
relative=$1
if [ -n "$relative" ]; then cd "$root/$relative"; else cd "$root"; fi
resolved=$(pwd -P)
case "$resolved" in "$root"|"$root"/*) ;; *) echo 'Path escapes the assigned workspace' >&2; exit 126;; esac
for entry in ./* ./.[!.]* ./..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  [ -L "$entry" ] && continue
  if [ -d "$entry" ]; then kind=directory; size=0
  elif [ -f "$entry" ]; then kind=file; size=$(wc -c < "$entry" | tr -d '[:space:]')
  else continue
  fi
  name=$(printf '%s' "${'${entry#./}'}" | base64 | tr -d '\r\n')
  printf '%s\t%s\t%s\n' "$kind" "$size" "$name"
done
`;
  if (operation === 'sandbox.fs.read') return String.raw`
set -eu
root=${root}
relative=$1
parent=${'${relative%/*}'}
name=${'${relative##*/}'}
[ "$parent" != "$relative" ] || parent=.
cd "$root/$parent"
resolved=$(pwd -P)
case "$resolved" in "$root"|"$root"/*) ;; *) echo 'Path escapes the assigned workspace' >&2; exit 126;; esac
target="./$name"
[ ! -L "$target" ] || { echo 'Symbolic links are not permitted' >&2; exit 126; }
[ -f "$target" ] || { echo 'Only regular files can be read' >&2; exit 126; }
exec 3< "$target"
opened=$(readlink "/proc/$$/fd/3")
case "$opened" in "$root"|"$root"/*) ;; *) echo 'Opened file escapes the assigned workspace' >&2; exit 126;; esac
[ -f "/proc/$$/fd/3" ] || { echo 'Only regular files can be read' >&2; exit 126; }
size=$(stat -c '%s' "/proc/$$/fd/3")
[ "$size" -le 2097152 ] || { echo 'File exceeds the 2 MiB read limit' >&2; exit 126; }
base64 <&3 | tr -d '\r\n'
`;
  if (operation === 'sandbox.fs.write') return String.raw`
set -eu
root=${root}
relative=$1
case "$relative" in ''|/*) echo 'Path must be workspace-relative' >&2; exit 126;; esac
case "/$relative/" in */../*|*/./*) echo 'Path contains an unsafe component' >&2; exit 126;; esac
parent=${'${relative%/*}'}
name=${'${relative##*/}'}
[ "$parent" != "$relative" ] || parent=.
cd "$root/$parent"
resolved=$(pwd -P)
case "$resolved" in "$root"|"$root"/*) ;; *) echo 'Path escapes the assigned workspace' >&2; exit 126;; esac
target="./$name"
[ ! -L "$target" ] || { echo 'Symbolic links are not permitted' >&2; exit 126; }
if [ -e "$target" ] && [ ! -f "$target" ]; then echo 'Only regular files can be replaced' >&2; exit 126; fi
temporary=$(mktemp .vps-mcp.XXXXXX)
trap 'rm -f "$temporary"' EXIT
cat > "$temporary"
mv -f "$temporary" "$target"
trap - EXIT
`;
  throw new Error('Unsupported sandbox filesystem operation');
}

export function parseSandboxDirectoryListing(output) {
  return output.split('\n').filter(Boolean).map((line) => {
    const [type, size, encodedName] = line.split('\t');
    assert((type === 'file' || type === 'directory') && /^\d+$/.test(size ?? '') && typeof encodedName === 'string', 'Runtime returned an invalid filesystem listing');
    const nameBytes = Buffer.from(encodedName, 'base64');
    assert(nameBytes.toString('base64') === encodedName, 'Runtime returned an invalid filename encoding');
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); }
    catch { throw new Error('Runtime returned a filename that is not valid UTF-8'); }
    return { name, type, sizeBytes: Number(size) };
  });
}

export function decodeSandboxFile(encoded) {
  assert(typeof encoded === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 'Runtime returned invalid file encoding');
  const data = Buffer.from(encoded, 'base64');
  assert(data.toString('base64') === encoded, 'Runtime returned invalid file encoding');
  assert(data.length <= MAX_SANDBOX_FILE_BYTES, 'File exceeds the 2 MiB read limit');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw new Error('File is not valid UTF-8'); }
  return { content, sizeBytes: data.length };
}

export function hasSandboxCapacity(activeCount) {
  return Number.isInteger(activeCount) && activeCount >= 0 && activeCount < MAX_SANDBOX_CONCURRENCY;
}

export function isSandboxBusy(activeCount) { return Number.isInteger(activeCount) && activeCount > 0; }

export function assertTaskWorkspaceWritable(record) {
  assert(record?.workloadType === 'task' && record.workspaceMount?.access === 'read-write', 'Task sandbox workspace is read-only');
}

async function runPodmanWithInput(args, input, timeout = DEFAULT_TIMEOUT_MS, maxBuffer = MAX_RESPONSE_BYTES) {
  return await new Promise((resolve, reject) => {
    const child = execFile(PODMAN, ['--cgroup-manager=cgroupfs', ...args], {
      encoding: 'utf8', timeout, maxBuffer,
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/var/lib/vps-sandbox',
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? '',
      },
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout ?? '';
        error.stderr = stderr ?? '';
        reject(error);
      } else resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
    });
    child.stdin.end(input);
  });
}

export function buildSandboxFilesystemArgs({ runtimeId, operation, path: relative }) {
  const script = buildSandboxFilesystemScript(operation);
  const interactive = operation === 'sandbox.fs.write';
  return ['exec', ...(interactive ? ['-i'] : []), runtimeId, 'sh', '-c', script, '--', relative];
}

async function sandboxFilesystem(request) {
  const { record, runtimeId } = await taskSandboxRecord(request.sandboxId);
  if (request.operation === 'sandbox.fs.write') {
    assertTaskWorkspaceWritable(record);
    const active = await listExecutionRecords(request.sandboxId);
    for (const item of active) if (['starting', 'running', 'cancelling'].includes(item.status)) await refreshExecutionStatus(request.sandboxId, item.id);
    const reconciled = await listExecutionRecords(request.sandboxId);
    assert(!reconciled.some((item) => ['starting', 'running', 'cancelling', 'unknown'].includes(item.status)), 'SANDBOX_EXECUTION_BUSY: cancel or wait for the background command before writing workspace files');
  }
  if (request.operation === 'sandbox.fs.write') {
    const result = await runPodmanWithInput(buildSandboxFilesystemArgs({ runtimeId, operation: request.operation, path: request.path }), request.content, 30_000, 128 * 1024);
    return { sandboxId: record.id, path: request.path, sizeBytes: Buffer.byteLength(request.content, 'utf8'), written: true, output: result.stdout.trim() };
  }
  const maxBuffer = request.operation === 'sandbox.fs.read' ? 3 * 1024 * 1024 : 1024 * 1024;
  const result = await runPodman(buildSandboxFilesystemArgs({ runtimeId, operation: request.operation, path: request.path }), 30_000, maxBuffer);
  if (request.operation === 'sandbox.fs.read') return { sandboxId: record.id, path: request.path, ...decodeSandboxFile(result.stdout.trim()) };
  return { sandboxId: record.id, path: request.path, entries: parseSandboxDirectoryListing(result.stdout) };
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]{16,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

export function boundedSandboxOutput(stdout, stderr, maximumBytes) {
  const output = Buffer.from(redactSensitiveText(stdout), 'utf8');
  const error = Buffer.from(redactSensitiveText(stderr), 'utf8');
  const truncated = output.length + error.length > maximumBytes;
  const boundedOutput = output.subarray(0, maximumBytes);
  const remaining = Math.max(0, maximumBytes - boundedOutput.length);
  const boundedError = error.subarray(0, remaining);
  return { stdout: boundedOutput.toString('utf8'), stderr: boundedError.toString('utf8'), truncated };
}

export function buildSandboxExecArgs({ runtimeId, cwd, command, env = {} }) {
  validateWorkspaceRelativePath(cwd, true);
  const environment = Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const script = 'set -eu; root=/workspace; relative=$1; if [ -n "$relative" ]; then cd "$root/$relative"; else cd "$root"; fi; resolved=$(pwd -P); case "$resolved" in "$root"|"$root"/*) ;; *) echo "cwd escapes the assigned workspace" >&2; exit 126;; esac; shift; exec "$@"';
  return ['exec', '--workdir', '/workspace', ...environment, runtimeId, 'sh', '-c', script, '--', cwd, ...safeArgv(command)];
}

async function sandboxExecute(request) {
  const { record, runtimeId } = await taskSandboxRecord(request.sandboxId);
  const activeExecutions = await listExecutionRecords(request.sandboxId);
  for (const item of activeExecutions) if (['starting', 'running', 'cancelling'].includes(item.status)) await refreshExecutionStatus(request.sandboxId, item.id);
  const reconciledExecutions = await listExecutionRecords(request.sandboxId);
  assert(!reconciledExecutions.some((item) => ['starting', 'running', 'cancelling', 'unknown'].includes(item.status)), 'SANDBOX_EXECUTION_BUSY: use execution status/logs/cancel while a background command is active');
  assert(runtimeId, 'Task sandbox runtime container is missing');
  const cwdRelative = request.cwd ?? '';
  const maxOutputBytes = request.maxOutputBytes ?? 262_144;
  const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const args = buildSandboxExecArgs({ runtimeId, cwd: cwdRelative, command: request.command, env: request.env ?? {} });
    const result = await runPodman(args, timeout, maxOutputBytes + 1);
    const output = boundedSandboxOutput(result.stdout, result.stderr, maxOutputBytes);
    return { sandboxId: record.id, cwd: cwdRelative, exitCode: 0, ...output, timedOut: false };
  } catch (error) {
    const failure = error;
    if (Number.isInteger(failure.code)) {
      const output = boundedSandboxOutput(failure.stdout ?? '', failure.stderr ?? '', maxOutputBytes);
      return { sandboxId: record.id, cwd: cwdRelative, exitCode: failure.code, ...output, timedOut: false };
    }
    if (failure.code === 'ETIMEDOUT' || failure.killed) return { sandboxId: record.id, cwd: cwdRelative, exitCode: null, ...boundedSandboxOutput(failure.stdout ?? '', failure.stderr ?? '', maxOutputBytes), timedOut: true };
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { sandboxId: record.id, cwd: cwdRelative, exitCode: null, ...boundedSandboxOutput(failure.stdout ?? '', failure.stderr ?? '', maxOutputBytes), timedOut: false, truncated: true };
    throw error;
  }
}


function executionLogPaths(sandboxId, executionId) {
  const root = executionLogDirectory(sandboxId);
  const id = safeExecutionId(executionId);
  return { log: path.join(root, id + '.log'), identity: path.join(root, id + '.identity'), status: path.join(root, id + '.status'), reason: path.join(root, id + '.reason') };
}
async function readRegularText(file, maximumBytes = 4096) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximumBytes) return null;
    return await handle.readFile('utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function executionIdentityFromMount(sandboxId, executionId) {
  const raw = await readRegularText(executionLogPaths(sandboxId, executionId).identity);
  if (!raw) return null;
  const parts = raw.trim().split(' ');
  if (parts.length !== 3 || parts.some((part) => !/^[0-9]+$/.test(part))) return null;
  return { containerPid: Number(parts[0]), processGroupId: Number(parts[1]), processStartTime: parts[2] };
}
async function executionStatusFile(sandboxId, executionId) {
  const raw = await readRegularText(executionLogPaths(sandboxId, executionId).status, 64);
  if (raw === null) return null;
  const value = raw.trim();
  if (!/^-?[0-9]+$/.test(value)) return null;
  return Number(value);
}
async function refreshExecutionLogStats(record) {
  const file = executionLogPaths(record.sandboxId, record.id).log;
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) { record.logBytes = 0; record.logsUnavailable = true; return record; }
    if (stat.size > EXECUTION_POLICY.maxLogBytes) {
      await handle.truncate(EXECUTION_POLICY.maxLogBytes);
      record.logBytes = EXECUTION_POLICY.maxLogBytes;
      record.logTruncated = true;
    } else {
      record.logBytes = stat.size;
      record.logTruncated = record.logTruncated === true;
    }
    record.logsUnavailable = false;
  } catch (error) {
    if (error.code === 'ENOENT') record.logBytes = 0;
    else if (error.code === 'ELOOP' || error.code === 'EISDIR') {
      record.logBytes = 0;
      record.logsUnavailable = true;
    } else throw error;
  } finally {
    await handle?.close();
  }
  return record;
}

async function verifyExecutionIdentity(runtimeId, executionId, identity) {
  if (!identity || !Number.isSafeInteger(identity.containerPid) || identity.containerPid <= 1 ||
      identity.processGroupId !== identity.containerPid || !/^[0-9]+$/.test(String(identity.processStartTime))) return false;
  try {
    await runPodman(['exec', runtimeId, 'sh', '-c', buildExecutionIdentityCheckScript(), '--', executionId,
      String(identity.containerPid), String(identity.processGroupId), String(identity.processStartTime)], 10_000, 16 * 1024);
    return true;
  } catch { return false; }
}
async function refreshExecutionStatus(sandboxId, executionId) {
  const record = await readExecutionRecord(sandboxId, executionId);
  const terminalStatuses = ['completed', 'cancelled', 'timed_out', 'interrupted', 'failed'];
  if (terminalStatuses.includes(record.status)) {
    await refreshExecutionLogStats(record);
    return record;
  }

  const paths = executionLogPaths(sandboxId, executionId);
  const exitCode = await executionStatusFile(sandboxId, executionId);
  const reason = (await readRegularText(paths.reason, 128))?.trim() ?? null;
  const workload = await readRecord(sandboxId);
  assertWorkloadTypeMatch(workload, 'task');
  const runtimeId = await resolveRuntimeId(workload);
  const runtimeState = runtimeId
    ? await runPodman(['inspect', '--format', '{{.State.Status}}', runtimeId]).then((value) => value.stdout.trim()).catch(() => 'missing')
    : 'missing';

  let identity = record.runtimeIdentity?.containerPid
    ? record.runtimeIdentity
    : record.status === 'starting' && Date.now() - Date.parse(record.createdAt) < 10_000
      ? await executionIdentityFromMount(sandboxId, executionId)
      : null;
  const processAlive = runtimeState === 'running' && identity
    ? await verifyExecutionIdentity(runtimeId, executionId, identity)
    : false;

  if (processAlive) {
    record.status = reason ? 'cancelling' : 'running';
    record.runtimeIdentity = { ...record.runtimeIdentity, ...identity, runtimeId };
    record.startedAt ??= record.createdAt;
  } else if (runtimeState !== 'running') {
    record.status = 'interrupted';
    record.cancelReason = runtimeState === 'missing' || workload.status === 'removed' ? 'sandbox_removed_or_missing' : 'sandbox_stopped';
    record.finishedAt ??= new Date().toISOString();
  } else if (identity && exitCode !== null) {
    record.status = reason === 'timeout' ? 'timed_out' : reason ? 'cancelled' : 'completed';
    record.exitCode = exitCode;
    record.cancelReason = reason === 'timeout' ? 'timeout' : reason;
    record.finishedAt ??= new Date().toISOString();
  } else if (identity && reason) {
    record.status = reason === 'timeout' ? 'timed_out' : 'cancelled';
    record.cancelReason = reason;
    record.finishedAt ??= new Date().toISOString();
  } else if (record.status === 'starting' && Date.now() - Date.parse(record.createdAt) < 10_000) {
    record.status = 'starting';
  } else {
    record.status = 'unknown';
    record.cancelReason = 'execution_identity_unavailable';
  }

  if (terminalStatuses.includes(record.status)) {
    record.logsExpireAt = new Date(Date.parse(record.finishedAt) + EXECUTION_POLICY.logRetentionMs).toISOString();
    record.recordExpireAt = new Date(Date.parse(record.finishedAt) + EXECUTION_POLICY.recordRetentionMs).toISOString();
  }
  record.updatedAt = new Date().toISOString();
  await refreshExecutionLogStats(record);
  await writeExecutionRecord(record);
  return record;
}

async function startSandboxExecution(request) {
  const { record: workload, runtimeId } = await taskSandboxRecord(request.sandboxId);
  assert(workload.executionMount?.destination === '/run/vps-mcp-executions' && workload.executionMount.path === executionLogDirectory(workload.id), 'SANDBOX_EXECUTION_UNAVAILABLE: sandbox was not created with durable execution storage');
  const executionMountStat = await fs.lstat(workload.executionMount.path);
  assert(executionMountStat.isDirectory() && !executionMountStat.isSymbolicLink() && await fs.realpath(workload.executionMount.path) === workload.executionMount.path, 'SANDBOX_EXECUTION_UNAVAILABLE: execution log mount is not canonical');
  assert(!activeExecutionStarts.has('__global__') && !activeExecutionStarts.has(request.sandboxId), 'SANDBOX_EXECUTION_BUSY: another execution is being started');
  activeExecutionStarts.add('__global__');
  activeExecutionStarts.add(request.sandboxId);
  try {
    await pruneExecutionRetention(request.sandboxId);
    const records = await listExecutionRecords(request.sandboxId);
    for (const item of records) if (['starting', 'running', 'cancelling', 'unknown'].includes(item.status)) await refreshExecutionStatus(request.sandboxId, item.id);
    const activeForSandbox = (await listExecutionRecords(request.sandboxId)).filter((item) => ['starting', 'running', 'cancelling', 'unknown'].includes(item.status)).length;
    assert(activeForSandbox < EXECUTION_POLICY.maxActivePerSandbox, 'SANDBOX_EXECUTION_QUOTA: maximum active executions for this sandbox reached');
    const allSandboxEntries = await fs.readdir(EXECUTION_RECORDS_DIR, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const entry of allSandboxEntries) if (entry.isDirectory() && UUID.test(entry.name)) await pruneExecutionRetention(entry.name);
    let activeGlobal = 0;
    for (const entry of allSandboxEntries) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      for (const item of await listExecutionRecords(entry.name)) {
        if (['starting', 'running', 'cancelling', 'unknown'].includes(item.status)) {
          await refreshExecutionStatus(entry.name, item.id);
          const refreshed = await readExecutionRecord(entry.name, item.id);
          if (['starting', 'running', 'cancelling', 'unknown'].includes(refreshed.status)) activeGlobal += 1;
        }
      }
    }
    assert(activeGlobal < EXECUTION_POLICY.maxActiveGlobal, 'SANDBOX_EXECUTION_QUOTA: global active execution limit reached');
    const usage = await sumRegularFileBytes(EXECUTION_LOG_ROOT);
    const sandboxUsage = await sumRegularFileBytes(executionLogDirectory(request.sandboxId));
    assertExecutionLogQuota({ globalBytes: usage, sandboxBytes: sandboxUsage });
    await runPodman(['exec', runtimeId, 'sh', '-c', 'for tool in setsid env head mkfifo awk sed grep tr sleep date; do command -v $tool >/dev/null 2>&1 || exit 127; done; ulimit -f 4097 >/dev/null 2>&1 || exit 127; test -d /run/vps-mcp-executions && test -w /run/vps-mcp-executions && test -r /proc/self/stat'], 10_000, 16 * 1024);
    const command = safeArgv(request.command);
    const cwd = request.cwd ?? '';
    validateWorkspaceRelativePath(cwd, true);
    const timeoutMs = request.timeoutMs ?? EXECUTION_POLICY.defaultTimeoutMs;
    assert(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= EXECUTION_POLICY.maxTimeoutMs, 'timeoutMs is outside the allowed range');
    const execution = createExecutionRecord({ sandboxId: workload.id, runtimeId, command, cwd, timeoutMs });
    await writeExecutionRecord(execution);
    try {
      await runPodman(buildExecutionStartArgs({ runtimeId, executionId: execution.id, cwd, timeoutMs, maxLogBytes: EXECUTION_POLICY.maxLogBytes, command }), 30_000, 32 * 1024);
    } catch (error) {
      execution.status = 'failed';
      execution.cancelReason = 'runtime_start_failed';
      execution.finishedAt = new Date().toISOString();
      execution.updatedAt = execution.finishedAt;
      await writeExecutionRecord(execution);
      throw error;
    }
    const deadline = Date.now() + 3000;
    let identity = null;
    while (Date.now() < deadline) {
      identity = await executionIdentityFromMount(workload.id, execution.id);
      if (identity) break;
      if (await executionStatusFile(workload.id, execution.id) !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (identity) {
      execution.runtimeIdentity = { runtimeId, ...identity, marker: execution.id };
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
    } else {
      execution.status = 'unknown';
      execution.cancelReason = 'runtime_identity_not_recorded';
    }
    execution.updatedAt = new Date().toISOString();
    await refreshExecutionLogStats(execution);
    await writeExecutionRecord(execution);
    const refreshed = await refreshExecutionStatus(workload.id, execution.id);
    return { sandboxId: workload.id, executionId: execution.id, status: refreshed.status, command: execution.command, cwd,
      exitCode: refreshed.exitCode, timeoutAt: execution.timeoutAt, logLimitBytes: EXECUTION_POLICY.maxLogBytes, createdAt: execution.createdAt };
  } finally {
    activeExecutionStarts.delete(request.sandboxId);
    activeExecutionStarts.delete('__global__');
  }
}
function executionSummary(record) {
  return {
    executionId: record.id, sandboxId: record.sandboxId, status: record.status, command: record.command, cwd: record.cwd,
    exitCode: record.exitCode, timeoutAt: record.timeoutAt, cancelReason: record.cancelReason, logBytes: record.logBytes,
    logTruncated: record.logTruncated, logsExpired: record.logsExpired === true, logsUnavailable: record.logsUnavailable === true, logsExpireAt: record.logsExpireAt, createdAt: record.createdAt,
    startedAt: record.startedAt, finishedAt: record.finishedAt,
  };
}
async function listSandboxExecutions(sandboxId) {
  const workload = await readRecord(sandboxId);
  assertWorkloadTypeMatch(workload, 'task');
  await pruneExecutionRetention(sandboxId);
  const records = await listExecutionRecords(sandboxId);
  const result = [];
  for (const item of records.slice(-100)) result.push(await refreshExecutionStatus(sandboxId, item.id));
  return { sandboxId, executions: result.map(executionSummary) };
}
async function getSandboxExecutionStatus(sandboxId, executionId) {
  const workload = await readRecord(sandboxId);
  assertWorkloadTypeMatch(workload, 'task');
  return executionSummary(await refreshExecutionStatus(sandboxId, executionId));
}
async function getSandboxExecutionLogs(sandboxId, executionId, offset, maxBytes) {
  const workload = await readRecord(sandboxId);
  assertWorkloadTypeMatch(workload, 'task');
  await pruneExecutionRetention(sandboxId);
  const record = await refreshExecutionStatus(sandboxId, executionId);
  assert(!record.logsExpired, 'SANDBOX_EXECUTION_LOG_EXPIRED: execution logs passed their retention period');
  assert(!record.logsUnavailable, 'SANDBOX_EXECUTION_LOG_UNAVAILABLE: log path is not a regular file');
  const file = executionLogPaths(sandboxId, executionId).log;
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stat = await handle.stat();
    assert(stat.isFile() && stat.size <= EXECUTION_POLICY.maxLogBytes, 'Execution log is not a bounded regular file');
    const maximum = maxBytes ?? 65_536;
    const window = executionLogReadWindow(stat.size, offset, maximum);
    const { offset: start, length } = window;
    const buffer = Buffer.alloc(length);
    const result = length ? await handle.read(buffer, 0, length, start) : { bytesRead: 0 };
    const nextOffset = start + result.bytesRead;
    return { ...executionSummary(record), logs: redactSensitiveText(buffer.subarray(0, result.bytesRead).toString('utf8')), offset: start,
      nextOffset, sizeBytes: stat.size, hasMore: nextOffset < stat.size };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...executionSummary(record), logs: '', offset: offset ?? 0, nextOffset: offset ?? 0, sizeBytes: 0, hasMore: false };
    if (error.code === 'ELOOP') throw new Error('SANDBOX_EXECUTION_LOG_UNAVAILABLE: log path is not a regular file');
    throw error;
  } finally {
    await handle?.close();
  }
}

async function cancelSandboxExecution(sandboxId, executionId, reason = 'cancelled') {
  const workload = await readRecord(sandboxId);
  assertWorkloadTypeMatch(workload, 'task');
  let record = await refreshExecutionStatus(sandboxId, executionId);
  if (!['starting', 'running', 'cancelling'].includes(record.status)) return { ...executionSummary(record), cancelled: false };
  const runtimeId = await resolveRuntimeId(workload);
  if (!runtimeId || workload.status === 'removed') {
    record.status = 'interrupted';
    record.cancelReason = 'sandbox_removed_or_missing';
    record.finishedAt = new Date().toISOString();
    record.updatedAt = record.finishedAt;
    await writeExecutionRecord(record);
    return { ...executionSummary(record), cancelled: false };
  }
  const identity = record.runtimeIdentity;
  if (!identity?.containerPid || !identity?.processGroupId || !identity?.processStartTime) {
    record.status = 'unknown';
    record.cancelReason = 'execution_identity_unavailable';
    record.updatedAt = new Date().toISOString();
    await writeExecutionRecord(record);
    return { ...executionSummary(record), cancelled: false };
  }
  try {
    await runPodman(['exec', runtimeId, 'sh', '-c', buildExecutionCancelScript(), '--', executionId, reason,
      String(identity.containerPid), String(identity.processGroupId), String(identity.processStartTime)], 10_000, 16 * 1024);
  } catch (error) {
    if (!Number.isInteger(error?.code)) throw error;
  }
  const deadline = Date.now() + 3000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 100));
    record = await refreshExecutionStatus(sandboxId, executionId);
  } while (Date.now() < deadline && ['starting', 'running', 'cancelling'].includes(record.status));
  if (['starting', 'running', 'cancelling'].includes(record.status)) {
    record.status = 'unknown';
    record.cancelReason = 'cancellation_not_confirmed';
    record.updatedAt = new Date().toISOString();
    await writeExecutionRecord(record);
  }
  return { ...executionSummary(record), cancelled: ['cancelled', 'timed_out', 'interrupted'].includes(record.status) };
}
async function cancelActiveSandboxExecutions(sandboxId, reason) {
  const records = await listExecutionRecords(sandboxId);
  for (const record of records) {
    if (['starting', 'running', 'cancelling'].includes(record.status)) {
      await cancelSandboxExecution(sandboxId, record.id, reason);
    }
  }
}
async function markActiveExecutionsInterrupted(sandboxId, reason) {
  for (const record of await listExecutionRecords(sandboxId)) {
    if (!['starting', 'running', 'cancelling', 'unknown'].includes(record.status)) continue;
    record.status = 'interrupted';
    record.cancelReason = reason;
    record.finishedAt = new Date().toISOString();
    record.logsExpireAt = new Date(Date.parse(record.finishedAt) + EXECUTION_POLICY.logRetentionMs).toISOString();
    record.recordExpireAt = new Date(Date.parse(record.finishedAt) + EXECUTION_POLICY.recordRetentionMs).toISOString();
    record.updatedAt = record.finishedAt;
    await fs.rm(path.join(executionLogDirectory(sandboxId), record.id + '.fifo'), { force: true });
    await fs.rm(path.join(executionLogDirectory(sandboxId), record.id + '.cancel'), { force: true });
    await refreshExecutionLogStats(record);
    await writeExecutionRecord(record);
  }
}

async function execute(request) {
  await ensureDataDir();
  if (request.operation === 'sandbox.execution.start') return startSandboxExecution(request);
  if (request.operation === 'sandbox.execution.list') return listSandboxExecutions(request.sandboxId);
  if (request.operation === 'sandbox.execution.status') return getSandboxExecutionStatus(request.sandboxId, request.executionId);
  if (request.operation === 'sandbox.execution.logs') return getSandboxExecutionLogs(request.sandboxId, request.executionId, request.offset, request.maxBytes);
  if (request.operation === 'sandbox.execution.cancel') return cancelSandboxExecution(request.sandboxId, request.executionId);
  if (request.operation === 'sandbox.exec') return sandboxExecute(request);
  if (request.operation.startsWith('sandbox.fs.')) return sandboxFilesystem(request);
  if (request.operation === 'image.inspect' || request.operation === 'image.pull') return imageOperation(request);
  if (request.operation === 'container.create') return createWorkload(request);
  if (request.operation === 'container.list') {
    const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
    const records = [];
    for (const entry of entries) if (entry.isDirectory() && UUID.test(entry.name)) {
      try {
        const record = await readRecord(entry.name);
        if (record.status !== 'removed') {
          const runtimeId = await resolveRuntimeId(record);
          if (runtimeId) {
            const state = await runPodman(['inspect', '--format', '{{.State.Status}}', runtimeId])
              .then((value) => value.stdout.trim()).catch(() => 'missing');
            const status = state === 'running' ? 'running' : state === 'created' ? 'created' : state === 'exited' ? 'stopped' : 'unknown';
            const reconciled = { ...record, runtimeId, status, updatedAt: new Date().toISOString() };
            await writeRecord(reconciled);
            records.push(reconciled);
          } else {
          if (!record.runtimeId && ['creating', 'starting', 'stopping', 'removing'].includes(record.status)) {
            const interrupted = { ...record, status: 'unknown', updatedAt: new Date().toISOString() };
            await writeRecord(interrupted);
            records.push(interrupted);
          } else {
            records.push(record);
          }
          }
        } else {
          records.push(record);
        }
      } catch { /* incomplete records remain on disk for operator review */ }
    }
    return { workloads: records };
  }
  const id = safeId(request.workloadId);
  if (request.operation === 'container.inspect') {
    const record = await readRecord(id);
    const runtimeId = await resolveRuntimeId(record);
    if (!runtimeId) {
      const missing = { ...record, status: 'unknown', updatedAt: new Date().toISOString() };
      await writeRecord(missing);
      return { workload: missing, runtime: null, reconciliation: 'runtime container is missing; record retained for operator review' };
    }
    const result = await runPodman(['inspect', '--format', '{{json .State}}', runtimeId]).catch(() => null);
    if (!result) {
      const missing = { ...record, status: 'unknown', updatedAt: new Date().toISOString() };
      await writeRecord(missing);
      return { workload: missing, runtime: null, reconciliation: 'runtime container is missing; record retained for operator review' };
    }
    let runtime;
    try { runtime = JSON.parse(result.stdout.trim()); } catch { throw new Error('Podman returned invalid inspect JSON'); }
    const status = runtime.Status === 'running' ? 'running' : runtime.Status === 'exited' ? 'stopped' : record.status;
    const updated = { ...record, runtimeId, status, updatedAt: new Date().toISOString() };
    await writeRecord(updated);
    return { workload: updated, runtime };
  }
  if (request.operation === 'container.start') return mutate(request, (r) => runPodman(['start', r.runtimeId]));
  if (request.operation === 'container.stop') return mutate(request, (r) => runPodman(['stop', '--time', '10', r.runtimeId], 30_000));
  if (request.operation === 'container.remove') {
    const record = await readRecord(id);
    assertWorkloadTypeMatch(record, request.expectedWorkloadType);
    const runtimeId = await resolveRuntimeId(record);
    if (!runtimeId) {
      if (record.workloadType === 'task') await markActiveExecutionsInterrupted(record.id, 'sandbox_removed');
      const removed = { ...record, status: 'removed', updatedAt: new Date().toISOString() };
      await writeRecord(removed);
      return { workload: removed, removed: true };
    }
    if (record.workloadType === 'task') await cancelActiveSandboxExecutions(record.id, 'sandbox_removed');
    await writeRecord({ ...record, runtimeId, status: 'removing', updatedAt: new Date().toISOString() });
    const exists = await runPodman(['inspect', '--format', '{{.Id}}', runtimeId]).then(() => true).catch(() => false);
    if (!exists) {
      if (record.workloadType === 'task') await markActiveExecutionsInterrupted(record.id, 'sandbox_removed');
      const missing = { ...record, status: 'removed', runtimeId: null, updatedAt: new Date().toISOString() };
      await writeRecord(missing);
      return { workload: missing, removed: true };
    }
    const result = await runPodman(['rm', '--force', runtimeId], 30_000);
    if (record.workloadType === 'task') await markActiveExecutionsInterrupted(record.id, 'sandbox_removed');
    const updated = { ...record, status: 'removed', updatedAt: new Date().toISOString(), runtimeId: null };
    await writeRecord(updated);
    return { workload: updated, output: result.stdout.trim() };
  }
  if (request.operation === 'container.exec') {
    const record = await readRecord(id);
    const runtimeId = await resolveRuntimeId(record);
    assert(record.status === 'running' && runtimeId, 'Workload is not running');
    const argv = safeArgv(request.command);
    const timeout = Math.min(Math.max(Number.isInteger(request.timeoutMs) ? request.timeoutMs : DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    try {
      const result = await runPodman(['exec', runtimeId, ...argv], timeout);
      return { workloadId: id, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error;
      if (Number.isInteger(failure.code)) return { workloadId: id, exitCode: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
      throw error;
    }
  }
  if (request.operation === 'container.logs') {
    const record = await readRecord(id);
    const runtimeId = await resolveRuntimeId(record);
    assert(runtimeId, 'Workload has no runtime container');
    const result = await runPodman(['logs', '--tail', '500', runtimeId], 30_000);
    return { workloadId: id, logs: result.stdout + result.stderr };
  }
  throw new Error('Unsupported runtime operation');
}
function respond(socket, value) {
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload, 'utf8') > MAX_RESPONSE_BYTES) socket.end(JSON.stringify({ error: 'Response exceeds configured limit' }) + '\n');
  else socket.end(payload + '\n');
}
function handleConnection(socket) {
  let input = '';
  let handled = false;
  socket.setTimeout(150_000);
  socket.on('data', async (chunk) => {
    if (handled) { socket.destroy(); return; }
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) { handled = true; respond(socket, { error: 'Request is too large' }); return; }
    const newline = input.indexOf('\n');
    if (newline < 0) return;
    handled = true;
    if (newline !== input.length - 1) { respond(socket, { error: 'Only one request is allowed per connection' }); return; }
    try {
      const request = parseRuntimeRequest(input.slice(0, newline));
      const sandboxId = request.sandboxId ?? (request.expectedWorkloadType === 'task' ? request.workloadId : null);
      const sandboxOperation = request.operation.startsWith('sandbox.') || sandboxId !== null;
      if (sandboxOperation) {
        const sandboxMutation = ['sandbox.exec', 'sandbox.fs.write', 'sandbox.execution.start', 'sandbox.execution.cancel'].includes(request.operation) ||
          (request.expectedWorkloadType === 'task' && ['container.start', 'container.stop', 'container.remove'].includes(request.operation));
        if (mutatingWorkloads.has(sandboxId) || (sandboxMutation && isSandboxBusy(activeSandboxWorkloads.get(sandboxId) ?? 0))) {
          respond(socket, { error: 'SANDBOX_BUSY: another task operation or lifecycle mutation is in progress' });
          return;
        }
        if (!hasSandboxCapacity(activeSandboxOperations)) {
          respond(socket, { error: 'SANDBOX_CAPACITY_EXCEEDED: maximum concurrent sandbox operations reached' });
          return;
        }
        if (sandboxMutation) mutatingWorkloads.add(sandboxId);
        activeSandboxOperations += 1;
        activeSandboxWorkloads.set(sandboxId, (activeSandboxWorkloads.get(sandboxId) ?? 0) + 1);
        try { respond(socket, { result: await execute(request) }); }
        finally {
          activeSandboxOperations -= 1;
          const remaining = (activeSandboxWorkloads.get(sandboxId) ?? 1) - 1;
          if (remaining > 0) activeSandboxWorkloads.set(sandboxId, remaining);
          else activeSandboxWorkloads.delete(sandboxId);
          if (sandboxMutation) mutatingWorkloads.delete(sandboxId);
        }
      } else {
        const lifecycleMutation = ['container.start', 'container.stop', 'container.remove'].includes(request.operation);
        if (lifecycleMutation) {
          const id = request.workloadId;
          if (mutatingWorkloads.has(id) || isSandboxBusy(activeSandboxWorkloads.get(id) ?? 0)) {
            respond(socket, { error: 'SANDBOX_BUSY: task sandbox operations are active or a lifecycle mutation is already in progress' });
            return;
          }
          mutatingWorkloads.add(id);
        }
        const operation = operationQueue.then(() => execute(request));
        operationQueue = operation.then(() => undefined, () => undefined);
        try { respond(socket, { result: await operation }); }
        finally { if (lifecycleMutation) mutatingWorkloads.delete(request.workloadId); }
      }
    } catch (error) {
      respond(socket, { error: error instanceof Error ? error.message : 'Runtime operation failed' });
    }
  });
  socket.on('error', () => {});
  socket.on('timeout', () => socket.destroy());
}
function main() {
  if (process.getuid() === 0) { console.error('Runtime agent must never run as root.'); process.exit(77); }
  if (process.env.USER !== 'vps-sandbox') { console.error('Runtime agent must run as vps-sandbox.'); process.exit(77); }
  if (process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '1') {
    console.error('Runtime agent must be started by its systemd socket unit.'); process.exit(77);
  }
  const server = net.createServer(handleConnection);
  server.on('error', (error) => { console.error(error.message); process.exit(1); });
  server.listen({ fd: 3 });
}
if (import.meta.url === `file://${process.argv[1]}`) main();

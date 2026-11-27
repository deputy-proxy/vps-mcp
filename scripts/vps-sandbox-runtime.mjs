#!/usr/bin/node
import { execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EXECUTION_POLICY, safeExecutionId, executionCommandMetadata, buildExecutionStartArgs, buildExecutionIdentityCheckScript, buildExecutionCancelScript, createExecutionRecord, executionRetentionActions, assertExecutionLogQuota, executionLogReadWindow } from './executions.mjs';
import { promisify } from 'node:util';
import { redactSensitiveText } from './secret-redaction.mjs';
import { buildProjectPodCreateArgs, buildProjectPodMemberArgs, projectPodName, validateProjectPodInspection, validateProjectPodInfraInspection, validateProjectPodMemberInspection } from './project-pod.mjs';
import { resourceBudget, calculateResourceUsage, evaluateResourceRequest, cleanupEligibility, withDurableLocks, auditSafeValue, diskPressureLevel, operationReplayDecision, orphanContainerEligibility, staleLockIsReapable, staleTemporaryFile, createWorkloadReplayDecision, resourceReservationMatches } from './resource-governance.mjs';

const execFileAsync = promisify(execFile);
const SOCKET = '/run/vps-sandbox-runtime.sock';
const QUOTA_SOCKET = '/run/vps-sandbox-quota.sock';
const EGRESS_PROXY_HOST = 'http://127.0.0.1:3128';
const EGRESS_PROXY_CONTAINER = 'http://10.0.2.2:3128';
function restrictedTaskEgressEnabled() {
  return process.env.VPS_SANDBOX_EGRESS_ENABLED === 'true' &&
    process.env.VPS_SANDBOX_EGRESS_PROXY_URL === EGRESS_PROXY_HOST &&
    process.env.VPS_SANDBOX_EGRESS_CONTAINER_PROXY_URL === EGRESS_PROXY_CONTAINER;
}
const DATA_DIR = '/var/lib/vps-sandbox/workloads';
const EXECUTION_RECORDS_DIR = '/var/lib/vps-sandbox/executions';
const EXECUTION_LOG_ROOT = '/var/lib/vps-sandbox/execution-logs';
const OPERATION_RECORDS_DIR = '/var/lib/vps-sandbox/operations';
const RESERVATION_ROOT = '/var/lib/vps-sandbox/reservations';
const AUDIT_ROOT = '/var/lib/vps-sandbox/audit';
const LOCK_ROOT = '/var/lib/vps-sandbox/locks';
const MAINTENANCE_FILE = '/var/lib/vps-sandbox/maintenance.json';
const WORKSPACE_WRITE_LEASE_ROOT = '/var/lib/vps-sandbox/operations/workspace-write-leases';
const WORKSPACE_WRITE_LEASE_TTL_MS = 30_000;
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
const OPERATIONS = new Set(['image.inspect', 'image.pull', 'container.create', 'container.start', 'container.inspect', 'container.list', 'container.stop', 'container.remove', 'container.exec', 'container.logs', 'project-service.recover', 'project-service.create', 'project-service.inspect', 'project-service.start', 'project-service.stop', 'project-service.remove', 'dashboard.inventory', 'sandbox.exec', 'sandbox.fs.list', 'sandbox.fs.read', 'sandbox.fs.write', 'sandbox.execution.start', 'sandbox.execution.status', 'sandbox.execution.logs', 'sandbox.execution.cancel', 'sandbox.execution.list', 'resource.inspect', 'resource.reserve', 'resource.release', 'sandbox.retention.set', 'cleanup.preview', 'cleanup.run', 'cleanup.pause', 'workspace.write.begin', 'workspace.write.finish', 'audit.list']);
let operationQueue = Promise.resolve();
const ACTIVE_STATES = new Set(['creating', 'created', 'starting', 'running', 'stopping', 'stopped', 'removing', 'error']);
const KNOWN_WORKLOAD_STATES = new Set([...ACTIVE_STATES, 'removed', 'unknown']);

function assert(condition, message) { if (!condition) throw new Error(message); }
function safeId(value) { assert(typeof value === 'string' && UUID.test(value), 'Invalid workload ID'); return value.toLowerCase(); }
export function safeImage(value) {
  assert(typeof value === 'string' && IMAGE_DIGEST.test(value), 'Image must be pinned by sha256 digest');
  const approved = (process.env.VPS_SANDBOX_ALLOWED_IMAGES ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  assert(approved.includes(value), 'Image digest is not present in the administrator-approved runtime image allowlist');
  return value;
}
function safeRepositoryId(value) { assert(typeof value === 'string' && REPOSITORY_ID.test(value), 'Invalid repository ID'); return value; }
function safeReleaseId(value) { assert(typeof value === 'string' && UUID.test(value), 'Invalid project release ID'); return value.toLowerCase(); }

export function configuredProjectEnvironmentRoots(env = process.env) {
  let entries;
  if (env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON !== undefined) {
    try { entries = JSON.parse(env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON); }
    catch { throw new Error('Project environment roots configuration must be valid JSON'); }
  } else {
    entries = [{
      root: env.VPS_SANDBOX_PROJECT_ENV_ROOT ?? '/var/lib/vps-mcp/project-environments',
      owner: env.VPS_SANDBOX_PROJECT_ENV_OWNER ?? 'vps-mcp',
    }];
  }
  assert(Array.isArray(entries) && entries.length >= 1 && entries.length <= 8,
    'Project environment roots configuration must contain between 1 and 8 roots');
  const roots = entries.map((entry) => {
    assert(entry && typeof entry === 'object' && !Array.isArray(entry)
      && typeof entry.root === 'string' && path.isAbsolute(entry.root)
      && !entry.root.includes(',') && /^\/[A-Za-z0-9._/-]+$/.test(entry.root)
      && typeof entry.owner === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(entry.owner),
    'Project environment roots configuration is invalid');
    return { root: path.resolve(entry.root), owner: entry.owner };
  });
  assert(new Set(roots.map((entry) => entry.root)).size === roots.length,
    'Project environment roots must be unique');
  return roots;
}

export function expectedProjectServiceMountSources(repositoryId, releaseId, roots = configuredProjectEnvironmentRoots()) {
  safeRepositoryId(repositoryId);
  safeReleaseId(releaseId);
  assert(Array.isArray(roots) && roots.length > 0, 'At least one approved project environment root is required');
  return roots.map(({ root }) => {
    assert(typeof root === 'string' && path.isAbsolute(root), 'Project environment root must be absolute');
    const environment = path.join(path.resolve(root), repositoryId);
    return {
      release: path.join(environment, 'releases', releaseId),
      storage: path.join(environment, 'storage'),
      cache: path.join(environment, 'cache'),
      logs: path.join(environment, 'logs'),
    };
  });
}
function safeRestartPolicy(value = 'unless-stopped') { assert(value === 'always' || value === 'unless-stopped', 'Unsupported project-service restart policy'); return value; }
function safeArgv(value) {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 64, 'Command must be a non-empty argument array');
  for (const arg of value) assert(typeof arg === 'string' && arg.length > 0 && arg.length <= 4096 && !arg.includes('\0'), 'Invalid command argument');
  return value;
}
function safeResources(value = {}) {
  const cpuMilli = value.cpuMilli ?? 1000;
  const memoryMiB = value.memoryMiB ?? 1024;
  const pids = value.pids ?? 128;
  const diskMiB = value.diskMiB ?? 2048;
  assert(Number.isInteger(cpuMilli) && cpuMilli >= 100 && cpuMilli <= 2000, 'cpuMilli must be between 100 and 2000');
  assert(Number.isInteger(memoryMiB) && memoryMiB >= 128 && memoryMiB <= 4096, 'memoryMiB must be between 128 and 4096');
  assert(Number.isInteger(pids) && pids >= 32 && pids <= 512, 'pids must be between 32 and 512');
  assert(Number.isInteger(diskMiB) && diskMiB >= 128 && diskMiB <= 102400, 'diskMiB must be between 128 and 102400');
  return { cpuMilli, memoryMiB, pids, diskMiB };
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
    'dashboard.inventory': ['operation'],
    'container.stop': ['operation', 'workloadId', 'expectedWorkloadType'],
    'container.remove': ['operation', 'workloadId', 'expectedWorkloadType'],
    'container.exec': ['operation', 'workloadId', 'command', 'timeoutMs'],
    'container.logs': ['operation', 'workloadId'],
    'project-service.recover': ['operation'],
    'project-service.create': ['operation', 'workloadId', 'repositoryId', 'releaseId', 'image', 'resources', 'reservationResources', 'restartPolicy', 'command'],
    'project-service.inspect': ['operation', 'workloadId'],
    'project-service.start': ['operation', 'workloadId'],
    'project-service.stop': ['operation', 'workloadId'],
    'project-service.remove': ['operation', 'workloadId', 'repositoryId', 'releaseId'],
    'sandbox.exec': ['operation', 'sandboxId', 'operationId', 'command', 'cwd', 'timeoutMs', 'maxOutputBytes', 'env'],
    'sandbox.fs.list': ['operation', 'sandboxId', 'path'],
    'sandbox.fs.read': ['operation', 'sandboxId', 'path'],
    'sandbox.fs.write': ['operation', 'sandboxId', 'path', 'content'],
    'sandbox.execution.start': ['operation', 'sandboxId', 'executionId', 'command', 'cwd', 'timeoutMs'],
    'sandbox.execution.status': ['operation', 'sandboxId', 'executionId'],
    'sandbox.execution.logs': ['operation', 'sandboxId', 'executionId', 'offset', 'maxBytes'],
    'sandbox.execution.cancel': ['operation', 'sandboxId', 'executionId'],
    'sandbox.execution.list': ['operation', 'sandboxId'],
    'sandbox.retention.set': ['operation', 'sandboxId', 'retained'],
    'resource.inspect': ['operation'],
    'resource.reserve': ['operation', 'repositoryId', 'resources'],
    'resource.release': ['operation', 'repositoryId'],
    'cleanup.preview': ['operation'],
    'cleanup.run': ['operation', 'dryRun', 'confirm'],
    'cleanup.pause': ['operation', 'paused'],
    'workspace.write.begin': ['operation', 'repositoryId', 'worktreeId'],
    'workspace.write.finish': ['operation', 'leaseId'],
    'audit.list': ['operation', 'limit'],
  }[request.operation];
  assert(Object.keys(request).every((key) => allowed.includes(key)), 'Request contains unsupported properties');
  if (request.operation === 'dashboard.inventory') return request;
  if (request.operation === 'project-service.create') {
    safeId(request.workloadId); safeRepositoryId(request.repositoryId); safeId(request.releaseId);
    safeImage(request.image);
    assert(request.resources && typeof request.resources === 'object' && !Array.isArray(request.resources), 'Project-service resource reservation is required');
    const resourceKeys = ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB'];
    assert(Object.keys(request.resources).every((key) => resourceKeys.includes(key)), 'Project-service resources contain unsupported properties');
    assert(resourceKeys.every((key) => Number.isSafeInteger(request.resources[key])), 'Project-service resources must define all four resource dimensions');
    safeResources(request.resources);
    assert(request.reservationResources && typeof request.reservationResources === 'object' && !Array.isArray(request.reservationResources), 'Aggregate project reservation is required');
    assert(Object.keys(request.reservationResources).every((key) => resourceKeys.includes(key)), 'Aggregate project reservation contains unsupported properties');
    assert(resourceKeys.every((key) => Number.isSafeInteger(request.reservationResources[key])), 'Aggregate project reservation must define all four resource dimensions');
    safeResources(request.reservationResources);
    for (const key of ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB']) assert(request.resources[key] <= request.reservationResources[key], 'Application resources exceed the aggregate project reservation');
    request.restartPolicy = safeRestartPolicy(request.restartPolicy);
    if (request.command !== undefined) {
      safeArgv(request.command);
      assert(JSON.stringify(request.command) === JSON.stringify(['--nodaemonize']), 'Project-service command must match the pinned PHP-FPM entrypoint');
    }
  }
  if (['project-service.inspect','project-service.start','project-service.stop'].includes(request.operation)) safeId(request.workloadId);
  if (request.operation === 'project-service.remove') {
    safeId(request.workloadId);
    safeRepositoryId(request.repositoryId);
    safeReleaseId(request.releaseId);
  }
  if (request.operation === 'container.create') {
    assert(request.workloadType === 'task', 'Generic container.create is reserved for task workloads');
    assert(request.network === undefined || request.network === 'none', 'Only network=none is supported by this runtime adapter');
  }
  if (request.operation === 'sandbox.retention.set') assert(typeof request.retained === 'boolean', 'retained must be a boolean');
  if (request.operation === 'resource.reserve') {
    safeRepositoryId(request.repositoryId);
    assert(request.resources && typeof request.resources === 'object' && !Array.isArray(request.resources), 'Resource reservation is required');
    assert(Object.keys(request.resources).every((key) => ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB'].includes(key)), 'Resource reservation contains unsupported properties');
    safeResources({ ...request.resources, diskMiB: request.resources.diskMiB ?? 10240 });
  }
  if (request.operation === 'resource.release') safeRepositoryId(request.repositoryId);
  if (request.operation === 'cleanup.run') {
    if (request.dryRun !== undefined) assert(typeof request.dryRun === 'boolean', 'dryRun must be a boolean');
    if (request.confirm !== undefined) assert(typeof request.confirm === 'boolean', 'confirm must be a boolean');
  }
  if (request.operation === 'cleanup.pause') assert(typeof request.paused === 'boolean', 'paused must be a boolean');
  if (request.operation === 'workspace.write.begin') { safeRepositoryId(request.repositoryId); safeId(request.worktreeId); }
  if (request.operation === 'workspace.write.finish') safeId(request.leaseId);
  if (request.operation === 'audit.list' && request.limit !== undefined) assert(Number.isInteger(request.limit) && request.limit >= 1 && request.limit <= 500, 'limit must be between 1 and 500');
  if (request.operation.startsWith('sandbox.')) {
    safeId(request.sandboxId);
    if (request.operation === 'sandbox.exec') {
      safeArgv(request.command);
      if (request.operationId !== undefined) safeExecutionId(request.operationId);
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
      if (request.executionId !== undefined) safeExecutionId(request.executionId);
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
async function quotaBrokerRequest(payload, timeoutMs = 60000) {
  const request = JSON.stringify(payload) + String.fromCharCode(10);
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(QUOTA_SOCKET); let response = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); if (error) reject(error); else resolve(value); };
    socket.setTimeout(timeoutMs); socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => { response += chunk.toString('utf8'); if (Buffer.byteLength(response) > 8192) finish(new Error('Quota broker response exceeded the allowed size.')); });
    socket.on('end', () => { try { const result = JSON.parse(response.trim()); if (result.error) finish(new Error('SANDBOX_DISK_QUOTA_UNAVAILABLE: ' + result.error)); else finish(undefined, result); } catch { finish(new Error('SANDBOX_DISK_QUOTA_UNAVAILABLE: quota broker returned invalid JSON')); } });
    socket.on('timeout', () => finish(new Error('SANDBOX_DISK_QUOTA_UNAVAILABLE: quota broker timed out')));
    socket.on('error', (error) => finish(new Error('SANDBOX_DISK_QUOTA_UNAVAILABLE: ' + (error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'quota broker is not installed or active' : error.code === 'EACCES' ? 'runtime identity cannot access the quota broker socket' : error.message))));
  });
}
async function applyWorkspaceDiskQuota(repositoryId, worktreeId, diskMiB) {
  const result = await quotaBrokerRequest({ operation: 'apply', repositoryId, worktreeId, diskMiB });
  assert(result.ok === true && result.enforcement === 'ext4-project-quota' && result.repositoryId === repositoryId && result.worktreeId === worktreeId && result.diskMiB === diskMiB, 'SANDBOX_DISK_QUOTA_UNAVAILABLE: quota broker returned an invalid result');
  return result;
}
async function stageWorkspaceMount(repositoryId, worktreeId, workloadId) {
  const result = await quotaBrokerRequest({ operation: 'stage', repositoryId, worktreeId, workloadId });
  assert(result.ok === true && result.repositoryId === repositoryId && result.worktreeId === worktreeId && result.workloadId === workloadId && result.stagedPath === `/var/lib/vps-sandbox-mounts/${repositoryId}/${worktreeId}/${workloadId}`, 'SANDBOX_WORKSPACE_MOUNT_FAILED: quota broker returned an invalid staging result');
  return result.stagedPath;
}
async function unstageWorkspaceMount(repositoryId, worktreeId, workloadId) {
  const result = await quotaBrokerRequest({ operation: 'unstage', repositoryId, worktreeId, workloadId });
  assert(result.ok === true && result.unstaged === true && result.repositoryId === repositoryId && result.worktreeId === worktreeId && result.workloadId === workloadId, 'SANDBOX_WORKSPACE_MOUNT_FAILED: quota broker returned an invalid unmount result');
  return result;
}
async function releaseWorkspaceMount(record) {
  if (record.workloadType === 'task' && record.workspaceMount?.path && record.worktreeId) await unstageWorkspaceMount(record.repositoryId, record.worktreeId, record.id);
}
async function applyProjectEnvironmentDiskQuota(repositoryId, workloadId, diskMiB) {
  const result = await quotaBrokerRequest({ operation: 'apply-project', repositoryId, workloadId, diskMiB }, 150000);
  assert(result.ok === true && result.repositoryId === repositoryId && result.environmentId === workloadId
    && result.diskMiB === diskMiB && result.enforcement === 'ext4-project-quota',
    'SANDBOX_PROJECT_QUOTA_FAILED: quota broker did not confirm the requested project disk limit');
  return result;
}
async function stageProjectServiceMounts(repositoryId, workloadId, releaseId) {
  const result = await quotaBrokerRequest({ operation: 'stage-project', repositoryId, workloadId, releaseId });
  const base = '/var/lib/vps-sandbox-mounts/projects/' + repositoryId + '/' + workloadId;
  const expected = { release: base + '/release', storage: base + '/storage', cache: base + '/cache', logs: base + '/logs' };
  assert(result.ok === true && result.repositoryId === repositoryId && result.workloadId === workloadId && result.releaseId === releaseId
    && JSON.stringify(result.stagedPaths) === JSON.stringify(expected), 'SANDBOX_PROJECT_MOUNT_FAILED: quota broker returned invalid project mount paths');
  return { releaseId, ...expected };
}
async function unstageProjectServiceMounts(repositoryId, workloadId, releaseId) {
  const result = await quotaBrokerRequest({ operation: 'unstage-project', repositoryId, workloadId, releaseId });
  assert(result.ok === true && result.unstaged === true && result.repositoryId === repositoryId && result.workloadId === workloadId && result.releaseId === releaseId,
    'SANDBOX_PROJECT_MOUNT_FAILED: quota broker returned an invalid project unmount result');
  return result;
}
async function releaseProjectServiceMounts(record) {
  if (record.workloadType === 'project-service' && record.projectMounts?.releaseId) {
    await unstageProjectServiceMounts(record.repositoryId, record.id, record.projectMounts.releaseId);
  }
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
  const file = executionRecordPath(sandboxId, executionId);
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Execution record is not a regular file');
  const raw = await readRegularText(file, 1024 * 1024);
  assert(raw !== null, 'Execution record is unreadable or oversized');
  const record = JSON.parse(raw);
  assert(record.id === safeExecutionId(executionId) && record.sandboxId === safeId(sandboxId), 'Execution record identity mismatch');
  return record;
}
async function listExecutionRecords(sandboxId) {
  const directory = path.join(EXECUTION_RECORDS_DIR, safeId(sandboxId));
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const records = [];
  for (const entry of entries) {
    if (!UUID.test(entry.name)) continue;
    assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Execution record directory is not a real directory');
    records.push(await readExecutionRecord(sandboxId, entry.name));
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
async function sumRegularFileBytes(directory) {
  const rootStat = await fs.lstat(directory);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink() && await fs.realpath(directory) === directory, 'Disk usage root must be a canonical real directory');
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
  const file = recordPath(id);
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Workload record is not a regular file');
  const raw = await readRegularText(file, 1024 * 1024);
  assert(raw !== null, 'Workload record is unreadable or oversized');
  const record = JSON.parse(raw);
  assert(record.id === safeId(id), 'Workload record identity mismatch');
  return record;
}
async function readWorkloadRecords(options = {}) {
  if (options.ensureDirectory !== false) await ensureDataDir();
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true }).catch((error) => {
    if (options.ensureDirectory === false && error.code === 'ENOENT') return [];
    throw error;
  });
  const records = [];
  for (const entry of entries) {
    if (!UUID.test(entry.name)) continue;
    try {
      assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Workload record path is not a real directory');
      const record = await readRecord(entry.name);
      assert(['task', 'project-service'].includes(record.workloadType), 'Workload record has an invalid workload type');
      safeRepositoryId(record.repositoryId);
      assert(KNOWN_WORKLOAD_STATES.has(record.status), 'Workload record has an invalid lifecycle state');
      assert(record.network === 'none' || (record.workloadType === 'task' && record.network === 'slirp4netns:allow_host_loopback=true'), 'Workload record has an unsupported network boundary');
      assert(record.runtimeId === null || record.runtimeId === undefined || /^[a-f0-9]{12,64}$/i.test(record.runtimeId), 'Workload record runtime ID is invalid');
      const validNetworkPolicy = record.workloadType === 'task'
        ? (record.network === 'none' ? ['task-no-egress', undefined] : ['task-restricted-egress'])
        : ['project-private-no-egress', undefined];
      assert(validNetworkPolicy.includes(record.networkPolicy), 'Workload record has an invalid network policy');
      if (record.worktreeId !== undefined) safeId(record.worktreeId);
      if (record.workloadType === 'task') {
        assert(record.worktreeId && record.workspaceMount?.destination === '/workspace', 'Task workload is missing its managed workspace mount');
        assert(['read-only', 'read-write'].includes(record.workspaceMount.access), 'Task workspace access mode is invalid');
        const roots = (process.env.VPS_SANDBOX_ALLOWED_WORKSPACE_ROOTS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
        const approvedRoots = roots.filter((root) => root === '/srv/vps-mcp-workspaces' || root === '/var/lib/vps-mcp/task-workspaces/worktrees');
        assert(approvedRoots.length === roots.length && approvedRoots.length > 0, 'Task workspace roots are not configured or approved');
        const expected = approvedRoots.map((root) => expectedTaskWorkspacePath(root, record.repositoryId, record.worktreeId));
        assert(expected.includes(path.resolve(record.workspaceMount.path)), 'Task workload workspace path does not match its registered identity');
      }
      if (record.workloadType === 'project-service') {
        if (record.podName !== undefined) assert(record.podName === projectPodName(record.repositoryId), 'Project-service workload has an invalid repository-private pod identity');
        assert(record.projectMounts && UUID.test(record.projectMounts.releaseId), 'Project-service workload is missing its release identity');
        assert(record.releaseId === record.projectMounts.releaseId, 'Project-service release identity does not match its mounts');
        const mountRoot = '/var/lib/vps-sandbox-mounts/projects/' + record.repositoryId + '/' + record.id;
        for (const [key, suffix] of Object.entries({ release: 'release', storage: 'storage', cache: 'cache', logs: 'logs' })) {
          const target = mountRoot + '/' + suffix;
          assert(record.projectMounts[key] === target, 'Project-service mount path is not canonical');
        }
      }
      assert(record.retained === undefined || typeof record.retained === 'boolean', 'Workload retention state is invalid');
      assert(record.resources && typeof record.resources === 'object' && !Array.isArray(record.resources), 'Workload resource vector is missing');
      assert(Object.keys(record.resources).every((key) => ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB'].includes(key)), 'Workload resource vector contains unsupported properties');
      assert(Number.isInteger(record.resources.cpuMilli) && Number.isInteger(record.resources.memoryMiB) && Number.isInteger(record.resources.pids), 'Workload resource vector is incomplete');
      record.resources = safeResources({ ...record.resources, diskMiB: record.resources.diskMiB ?? (record.workloadType === 'task' ? 2048 : 10240) });
      records.push(record);
    } catch { throw new Error(`SANDBOX_CAPACITY_UNKNOWN: workload record ${entry.name} is corrupt; resource admission is blocked`); }
  }
  return records;
}

function reservationPath(repositoryId) { return path.join(RESERVATION_ROOT, `${safeRepositoryId(repositoryId)}.json`); }
async function readReservations() {
  await fs.mkdir(RESERVATION_ROOT, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(RESERVATION_ROOT, { withFileTypes: true });
  const reservations = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    try {
      assert(entry.isFile() && !entry.isSymbolicLink(), 'Reservation record is not a regular file');
      const raw = await readRegularText(path.join(RESERVATION_ROOT, entry.name), 1024 * 1024);
      assert(raw !== null, 'Reservation record is unreadable or oversized');
      const reservation = JSON.parse(raw);
      safeRepositoryId(reservation.repositoryId);
      assert(entry.name === `${reservation.repositoryId}.json`, 'Reservation filename and repository identity do not match');
      assert(['reserved', 'released'].includes(reservation.status), 'Reservation has an invalid lifecycle status');
      assert(reservation.resources && typeof reservation.resources === 'object' && !Array.isArray(reservation.resources), 'Reservation resource vector is missing');
      assert(Object.keys(reservation.resources).every((key) => ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB'].includes(key)), 'Reservation resource vector contains unsupported properties');
      assert(Number.isInteger(reservation.resources.cpuMilli) && Number.isInteger(reservation.resources.memoryMiB) && Number.isInteger(reservation.resources.pids), 'Reservation resource vector is incomplete');
      reservation.resources = safeResources({ ...reservation.resources, diskMiB: reservation.resources.diskMiB ?? 10240 });
      reservations.push(reservation);
    } catch { throw new Error(`SANDBOX_CAPACITY_UNKNOWN: reservation record ${entry.name} is corrupt; resource admission is blocked`); }
  }
  return reservations;
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
}

function operationDirectory(sandboxId) { return path.join(OPERATION_RECORDS_DIR, safeId(sandboxId)); }
function operationRecordPath(sandboxId, operationId) { return path.join(operationDirectory(sandboxId), `${safeExecutionId(operationId)}.json`); }
async function readSandboxOperation(sandboxId, operationId) {
  const file = operationRecordPath(sandboxId, operationId);
  try { await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const raw = await readRegularText(file, 2 * 1024 * 1024);
    assert(raw !== null, 'Operation record is unreadable or oversized');
    const record = JSON.parse(raw);
    assert(record.sandboxId === sandboxId && record.operationId === operationId, 'Operation record identity does not match its path');
    assert(['running', 'unknown', 'completed', 'failed'].includes(record.status), 'Operation record has an invalid status');
    assert(typeof record.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(record.fingerprint), 'Operation record fingerprint is invalid');
    return record;
  } catch { throw new Error('SANDBOX_CAPACITY_UNKNOWN: idempotent operation record is corrupt or unreadable'); }
}

async function writeSandboxOperation(record) {
  const directory = operationDirectory(record.sandboxId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let stored = record;
  if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > 2 * 1024 * 1024 && record.result) {
    stored = { ...record, result: { ...record.result, ...boundedSandboxOutput(record.result.stdout ?? '', record.result.stderr ?? '', 256 * 1024), replayOutputTruncated: true } };
  }
  if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > 2 * 1024 * 1024 && stored.result) {
    stored = { ...stored, result: { ...stored.result, stdout: '', stderr: '', replayOutputTruncated: true } };
  }
  assert(Buffer.byteLength(JSON.stringify(stored), 'utf8') <= 2 * 1024 * 1024, 'SANDBOX_CAPACITY_EXCEEDED: idempotent operation result exceeds its storage limit');
  const temporary = path.join(directory, `.operation-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, operationRecordPath(record.sandboxId, record.operationId));
}
async function pruneSandboxOperations(sandboxId) {
  const directory = operationDirectory(sandboxId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    try {
      assert(entry.isFile() && !entry.isSymbolicLink(), 'Operation record is not a regular file');
      const raw = await readRegularText(path.join(directory, entry.name), 2 * 1024 * 1024);
      assert(raw !== null, 'Operation record is unreadable or oversized');
      const record = JSON.parse(raw);
      const operationId = safeExecutionId(entry.name.slice(0, -5));
      assert(record.sandboxId === sandboxId && record.operationId === operationId, 'Operation record identity mismatch');
      assert(['running', 'unknown', 'completed', 'failed'].includes(record.status) && /^[a-f0-9]{64}$/.test(record.fingerprint ?? ''), 'Operation record metadata is invalid');
      records.push({ path: path.join(directory, entry.name), record, mtimeMs: (await fs.stat(path.join(directory, entry.name))).mtimeMs });
    } catch { throw new Error('SANDBOX_CAPACITY_UNKNOWN: operation record is corrupt; execution retry is blocked'); }
  }
  if (records.length < 50) return;
  const workload = await readRecord(sandboxId).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const sandboxRemoved = workload?.status === 'removed';
  const removable = records.filter((item) => ['completed', 'failed'].includes(item.record.status) || (sandboxRemoved && ['running', 'unknown'].includes(item.record.status))).sort((a, b) => a.mtimeMs - b.mtimeMs);
  while (records.length >= 50 && removable.length) {
    const item = removable.shift();
    await fs.rm(item.path, { force: true });
    records.splice(records.indexOf(item), 1);
  }
  assert(records.length < 50, 'SANDBOX_CAPACITY_EXCEEDED: operation history is full; resolve unknown/running operations before retrying');
}
export function reconcileSandboxOperationRecord(record, finishedAt = new Date().toISOString()) {
  if (record.status !== 'running') return record;
  return { ...record, status: 'unknown', finishedAt, recoveryReason: 'runtime_agent_restarted' };
}

export function workspacePathsForStorageScan(records) {
  return [...new Set(records
    .filter((record) => record.status !== 'removed')
    .map((record) => record.workspaceMount?.path)
    .filter(Boolean))];
}

export function workspaceMountRecoveryCandidates(records) {
  return records.filter((record) => record.workloadType === 'task'
    && record.workspaceMount?.path
    && record.status === 'creating');
}

async function recoverSandboxOperations() {
  await fs.mkdir(OPERATION_RECORDS_DIR, { recursive: true, mode: 0o700 });
  const sandboxes = await fs.readdir(OPERATION_RECORDS_DIR, { withFileTypes: true });
  for (const sandbox of sandboxes) {
    if (!sandbox.isDirectory() || !UUID.test(sandbox.name)) continue;
    const directory = operationDirectory(sandbox.name);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      const file = path.join(directory, entry.name);
      let record;
      try {
        assert(entry.isFile() && !entry.isSymbolicLink(), 'Operation record is not a regular file');
        const raw = await readRegularText(file, 2 * 1024 * 1024);
        assert(raw !== null, 'Operation record is unreadable or oversized');
        record = JSON.parse(raw);
        const operationId = safeExecutionId(entry.name.slice(0, -5));
        assert(record.sandboxId === sandbox.name && record.operationId === operationId, 'Operation record identity mismatch');
        assert(['running', 'unknown', 'completed', 'failed'].includes(record.status) && /^[a-f0-9]{64}$/.test(record.fingerprint ?? ''), 'Operation record metadata is invalid');
      } catch { await appendAudit('sandbox.operation.recovery_failed', { sandboxId: sandbox.name, operationId: entry.name.slice(0, -5) }).catch(() => {}); continue; }
      const recoveredRecord = reconcileSandboxOperationRecord(record);
      if (recoveredRecord !== record) await writeSandboxOperation(recoveredRecord);
    }
  }
}

async function diskStatus() {
  const stats = await fs.statfs(DATA_DIR);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const budget = resourceBudget();
  return { path: DATA_DIR, totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes), level: diskPressureLevel(freeBytes, budget) };
}

async function resourceStatus() {
  const budget = resourceBudget();
  const [records, reservations, disk] = await Promise.all([readWorkloadRecords(), readReservations(), diskStatus()]);
  const usage = calculateResourceUsage(records, reservations);
  const storage = await runPodman(['system', 'df', '--format', 'json'], 15_000, 256 * 1024)
    .then((result) => { try { return JSON.parse(result.stdout); } catch { return { unavailable: true }; } })
    .catch(() => ({ unavailable: true }));
  const storageScanWarnings = [];
  const measure = async (directory) => sumRegularFileBytes(directory).catch((error) => { storageScanWarnings.push({ path: directory, reason: error instanceof Error ? error.message.slice(0, 160) : 'scan_failed' }); return 0; });
  const workspaces = workspacePathsForStorageScan(records);
  const [executionLogsBytes, executionRecordsBytes, operationRecordsBytes, workloadMetadataBytes, reservationBytes, auditBytes, workspaceSizes] = await Promise.all([
    measure(EXECUTION_LOG_ROOT), measure(EXECUTION_RECORDS_DIR), measure(OPERATION_RECORDS_DIR), measure(DATA_DIR), measure(RESERVATION_ROOT), measure(AUDIT_ROOT),
    Promise.all(workspaces.map(async (workspace) => ({ path: workspace, bytes: await measure(workspace) }))),
  ]);
  return {
    budget,
    usage,
    disk: { ...disk, reserveBytes: budget.diskReserveBytes, warningBytes: budget.diskWarningBytes, pressure: disk.freeBytes < budget.diskReserveBytes },
    containerStorage: storage,
    storageBreakdown: { executionLogsBytes, executionRecordsBytes, operationRecordsBytes, workloadMetadataBytes, reservationBytes, auditBytes,
      taskWorkspaces: { totalBytes: workspaceSizes.reduce((total, item) => total + item.bytes, 0), workspaces: workspaceSizes }, scanWarnings: storageScanWarnings },
    reservations: reservations.filter((item) => item.status !== 'released'),
    workloads: { total: records.length,
      activeTasks: records.filter((item) => item.workloadType === 'task' && ['creating', 'created', 'starting', 'running', 'stopping', 'removing', 'error', 'unknown'].includes(item.status)).length,
      activeProjectServices: records.filter((item) => item.workloadType === 'project-service' && ['creating', 'created', 'starting', 'running', 'stopping', 'removing', 'error', 'unknown'].includes(item.status)).length,
      removed: records.filter((item) => item.status === 'removed').length },
  };
}

async function appendAudit(action, details = {}) {
  await fs.mkdir(AUDIT_ROOT, { recursive: true, mode: 0o700 });
  const file = path.join(AUDIT_ROOT, `${new Date().toISOString().slice(0, 7)}.jsonl`);
  const entry = { at: new Date().toISOString(), action: auditSafeValue(action), pid: process.pid,
    details: Object.fromEntries(Object.entries(details).slice(0, 20).map(([key, value]) => [key, auditSafeValue(typeof value === 'string' ? value : JSON.stringify(value))])) };
  await withDurableLocks(LOCK_ROOT, ['audit-log'], async () => {
    const stat = await fs.stat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat && stat.size > 10 * 1024 * 1024) {
      const rotated = `${file}.${Date.now()}`;
      await fs.rename(file, rotated);
      const old = (await fs.readdir(AUDIT_ROOT)).filter((name) => name.includes('.jsonl') && name !== path.basename(file)).sort();
      for (const name of old.slice(0, Math.max(0, old.length - 5))) await fs.rm(path.join(AUDIT_ROOT, name), { force: true });
    }
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  });
}

async function readAudit(limit = 100) {
  await fs.mkdir(AUDIT_ROOT, { recursive: true, mode: 0o700 });
  const names = (await fs.readdir(AUDIT_ROOT)).filter((name) => name.includes('.jsonl'));
  const files = await Promise.all(names.map(async (name) => ({ name, mtimeMs: (await fs.stat(path.join(AUDIT_ROOT, name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const entries = [];
  for (const { name } of files) {
    const lines = (await fs.readFile(path.join(AUDIT_ROOT, name), 'utf8').catch(() => '')).split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* ignore malformed individual audit lines */ }
      if (entries.length >= limit) return entries;
    }
  }
  return entries;
}

async function maintenanceState() {
  try {
    const state = JSON.parse(await fs.readFile(MAINTENANCE_FILE, 'utf8'));
    return { paused: state.paused === true, updatedAt: state.updatedAt ?? null, reason: state.reason ?? null };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { paused: false, updatedAt: null, reason: null };
  }
}

async function assertWorkloadsNotPaused(operation) {
  const state = await maintenanceState();
  assert(!state.paused, `SANDBOX_MAINTENANCE_PAUSED: ${operation} is disabled while the emergency pause is active`);
}

async function setTaskSandboxRetention(request) {
  const record = await readRecord(request.sandboxId);
  assertWorkloadTypeMatch(record, 'task');
  assert(record.status !== 'removed', 'Cannot change retention on a removed task sandbox');
  const updated = { ...record, retained: request.retained, retentionUpdatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeRecord(updated);
  await appendAudit(request.retained ? 'sandbox.retained' : 'sandbox.retention_released', { sandboxId: record.id, repositoryId: record.repositoryId, worktreeId: record.worktreeId });
  return { sandboxId: record.id, retained: request.retained, workload: updated };
}

async function reserveProjectResources(request) {
  const resources = safeResources({ ...request.resources, diskMiB: request.resources.diskMiB ?? 10240 });
  const diskMiB = resources.diskMiB;
  const records = await readWorkloadRecords();
  await assertManagedContainerAccounting(records);
  await assertProjectContainersAccounted(request.repositoryId, records);
  const projectWorkloads = records.filter((item) => ['project-service', 'project-dependency'].includes(item.workloadType) && item.repositoryId === request.repositoryId && item.status !== 'removed');
  const allReservations = await readReservations();
  const currentReservation = allReservations.find((item) => item.repositoryId === request.repositoryId && item.status !== 'released');
  // A repeated reservation request is a no-op even while its project service is
  // running. This is required for safe retries of project-environment.register.
  if (resourceReservationMatches(currentReservation, resources)) {
    return { reservation: currentReservation, unchanged: true, capacity: await resourceStatus() };
  }
  assert(!projectWorkloads.some((item) => ['creating', 'created', 'starting', 'running', 'stopping', 'removing', 'error', 'unknown'].includes(item.status)), 'Project resource reservation is already consumed by an active project-service workload');
  for (const workload of projectWorkloads) {
    const runtimeId = await resolveRuntimeId(workload);
    if (!runtimeId) continue;
    const state = await inspectContainerState(runtimeId);
    assert(['missing', 'exited', 'created', 'configured', 'stopped'].includes(state), 'Cannot resize project reservation while a project-service container is running or in an unknown state');
  }
  const reservations = allReservations.filter((item) => item.repositoryId !== request.repositoryId);
  const disk = await diskStatus();
  const candidate = { workloadType: 'project-reservation', repositoryId: request.repositoryId, resources: { ...resources, diskMiB } };
  const decision = evaluateResourceRequest({ records, reservations, requested: candidate, budget: resourceBudget(), freeDiskBytes: disk.freeBytes });
  assert(decision.allowed, decision.reasons.join('; '));
  const reservation = { ...candidate, status: 'reserved', reservedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeJsonAtomic(reservationPath(request.repositoryId), reservation);
  await appendAudit('resource.reserved', { repositoryId: request.repositoryId, resources: reservation.resources });
  return { reservation, capacity: await resourceStatus() };
}

async function releaseProjectResources(repositoryId) {
  safeRepositoryId(repositoryId);
  const records = await readWorkloadRecords();
  await assertManagedContainerAccounting(records);
  await assertProjectContainersAccounted(repositoryId, records);
  assert(!records.some((item) => ['project-service', 'project-dependency'].includes(item.workloadType) && item.repositoryId === repositoryId && item.status !== 'removed'), 'Cannot release project capacity while a project-service workload record still exists');
  const reservation = (await readReservations()).find((item) => item.repositoryId === repositoryId);
  if (!reservation || reservation.status === 'released') return { repositoryId, released: false, reason: 'no_active_reservation' };
  reservation.status = 'released';
  reservation.releasedAt = new Date().toISOString();
  reservation.updatedAt = reservation.releasedAt;
  await writeJsonAtomic(reservationPath(repositoryId), reservation);
  await appendAudit('resource.released', { repositoryId });
  return { repositoryId, released: true, reservation };
}

function parseContainerLabels(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const labels = {};
  if (typeof value === 'string') {
    for (const item of value.split(',')) {
      const separator = item.indexOf('=');
      if (separator > 0) labels[item.slice(0, separator)] = item.slice(separator + 1);
    }
  }
  return labels;
}

export function normalizePodmanTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const goTimestamp = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))? ([+-]\d{2})(\d{2}) \S+$/.exec(raw);
  const candidate = goTimestamp
    ? goTimestamp[1] + 'T' + goTimestamp[2] + '.' + (goTimestamp[3] ?? '0').padEnd(3, '0').slice(0, 9) + goTimestamp[4] + ':' + goTimestamp[5]
    : raw;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function parsePodmanInspectResult(parsed) {
  const container = Array.isArray(parsed) ? parsed[0] : parsed;
  const state = container && typeof container === 'object' && !Array.isArray(container) ? (container.State ?? container.state ?? null) : null;
  if (!state || typeof state !== 'object') return { startedAt: null, networkPid: null };
  const pid = Number(state.Pid ?? state.pid);
  return { startedAt: state.Running === true || state.running === true ? normalizePodmanTimestamp(state.StartedAt ?? state.startedAt) : null, networkPid: Number.isSafeInteger(pid) && pid > 0 ? pid : null };
}

export function parseNetworkNamespaceCounters(contents) {
  if (typeof contents !== 'string' || contents.length > 64 * 1024) return null;
  let rx = 0;
  let tx = 0;
  let interfaces = 0;
  for (const line of contents.split(/\r?\n/).slice(2)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    if (!name || name === 'lo') continue;
    const counters = line.slice(separator + 1).trim().split(/\s+/);
    if (counters.length < 9 || !/^\d+$/.test(counters[0]) || !/^\d+$/.test(counters[8])) continue;
    const received = Number(counters[0]);
    const transmitted = Number(counters[8]);
    if (!Number.isSafeInteger(received) || !Number.isSafeInteger(transmitted)) return null;
    rx += received;
    tx += transmitted;
    interfaces += 1;
  }
  return interfaces > 0 && Number.isSafeInteger(rx) && Number.isSafeInteger(tx) ? { rxBytes: rx, txBytes: tx } : null;
}

async function inspectContainerRuntime(containerId) {
  try {
    const result = await runPodman(['inspect', '--format', 'json', containerId], 10_000, 256 * 1024);
    const parsed = JSON.parse(result.stdout || '[]');
    const inspected = parsePodmanInspectResult(parsed);
    let network = null;
    if (inspected.networkPid !== null) {
      try { network = parseNetworkNamespaceCounters(await fs.readFile('/proc/' + inspected.networkPid + '/net/dev', 'utf8')); }
      catch { /* network namespace counters are optional when procfs denies access */ }
    }
    return { startedAt: inspected.startedAt, network };
  } catch {
    return { startedAt: null, network: null };
  }
}

async function listManagedContainers({ includeMetrics = false } = {}) {
  const result = await runPodman(['ps', '--all', '--filter', 'label=io.cr8or.vps-mcp.workload', '--format', 'json'], 15_000, 1024 * 1024);
  const parsed = JSON.parse(result.stdout || '[]');
  assert(Array.isArray(parsed), 'Podman container inventory returned an invalid response');
  const containers = parsed.map((item) => {
    const labels = parseContainerLabels(item.Labels ?? item.Label ?? {});
    const state = String(item.State ?? item.Status ?? 'unknown').toLowerCase();
    return {
      containerId: String(item.Id ?? item.ID ?? '').toLowerCase(),
      workloadId: typeof labels['io.cr8or.vps-mcp.workload'] === 'string' && UUID.test(labels['io.cr8or.vps-mcp.workload']) ? labels['io.cr8or.vps-mcp.workload'].toLowerCase() : labels['io.cr8or.vps-mcp.workload'] ?? null,
      workloadType: labels['io.cr8or.vps-mcp.type'] ?? null,
      repositoryId: labels['io.cr8or.vps-mcp.repository'] ?? null,
      worktreeId: typeof labels['io.cr8or.vps-mcp.worktree'] === 'string' && UUID.test(labels['io.cr8or.vps-mcp.worktree']) ? labels['io.cr8or.vps-mcp.worktree'].toLowerCase() : labels['io.cr8or.vps-mcp.worktree'] ?? null,
      releaseId: typeof labels['io.cr8or.vps-mcp.release'] === 'string' && UUID.test(labels['io.cr8or.vps-mcp.release']) ? labels['io.cr8or.vps-mcp.release'].toLowerCase() : labels['io.cr8or.vps-mcp.release'] ?? null,
      state: state.startsWith('up ') ? 'running' : state.startsWith('exited') ? 'exited' : state,
      createdAt: typeof (item.CreatedAt ?? item.Created) === 'number' ? new Date(Number(item.CreatedAt ?? item.Created) * 1000).toISOString() : String(item.CreatedAt ?? item.Created ?? ''),
    };
  }).filter((item) => /^[a-f0-9]{12,64}$/.test(item.containerId));
  if (!includeMetrics) return containers;
  const metricContainers = containers.filter((container) => container.workloadType === 'task' && container.state === 'running');
  const metrics = new Map();
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, metricContainers.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= metricContainers.length) return;
      const container = metricContainers[index];
      metrics.set(container.containerId, await inspectContainerRuntime(container.containerId));
    }
  }));
  return containers.map((container) => ({
    ...container,
    ...(metrics.get(container.containerId) ?? { startedAt: null, network: null }),
  }));
}

async function assertManagedContainerAccounting(records) {
  const containers = await listManagedContainers();
  const recordById = new Map(records.map((record) => [record.id, record]));
  const counts = new Map();
  const terminal = new Set(['missing', 'created', 'configured', 'exited', 'stopped']);
  for (const container of containers) {
    const id = container.workloadId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    if (id && counts.get(id) > 1) throw new Error('SANDBOX_CAPACITY_UNKNOWN: multiple managed containers claim the same workload ID');
    const record = id ? recordById.get(id) : null;
    if (!record) {
      if (!terminal.has(container.state)) throw new Error('SANDBOX_CAPACITY_UNKNOWN: an untracked managed container is running or has an unknown state');
      continue;
    }
    assert(record.workloadType === container.workloadType && record.repositoryId === container.repositoryId && (record.worktreeId ?? null) === (container.worktreeId ?? null), 'SANDBOX_WORKLOAD_IDENTITY_MISMATCH: managed container labels do not match the workload registry');
    const runtimeId = await resolveRuntimeId(record);
    assert(runtimeId, 'SANDBOX_CAPACITY_UNKNOWN: a managed container could not be reconciled to its workload record');
    if (['removed', 'stopped'].includes(record.status) && !terminal.has(container.state)) throw new Error('SANDBOX_CAPACITY_UNKNOWN: container runtime state conflicts with its stopped or removed workload record');
  }
}

async function assertProjectContainersAccounted(repositoryId, records) {
  const containers = await listManagedContainers();
  for (const container of containers.filter((item) => ['project-service', 'project-dependency'].includes(item.workloadType) && item.repositoryId === repositoryId)) {
    const record = records.find((item) => item.id === container.workloadId);
    assert(record, 'SANDBOX_CAPACITY_UNKNOWN: an orphan project-service container exists for this repository');
    assert(record.workloadType === container.workloadType && record.repositoryId === container.repositoryId && (record.releaseId ?? null) === (container.releaseId ?? null) && (record.worktreeId ?? null) === (container.worktreeId ?? null), 'SANDBOX_WORKLOAD_IDENTITY_MISMATCH: project-service container labels do not match the registry');
    assert(record.status !== 'removed', 'SANDBOX_CAPACITY_UNKNOWN: a project container remains after its workload record was removed');
    const runtimeId = await resolveRuntimeId(record);
    assert(runtimeId, 'SANDBOX_CAPACITY_UNKNOWN: a project-service container could not be reconciled to its workload record');
  }
}

async function staleTemporaryFilePlan() {
  const staleMs = resourceBudget().temporaryFileRetentionMs;
  const roots = [
    { path: DATA_DIR, depth: 1 },
    { path: EXECUTION_RECORDS_DIR, depth: 2 },
    { path: OPERATION_RECORDS_DIR, depth: 1 },
    { path: RESERVATION_ROOT, depth: 0 },
    { path: '/var/lib/vps-sandbox', depth: 0 },
  ];
  const now = Date.now();
  const candidates = [];
  for (const root of roots) {
    const pending = [{ directory: root.path, depth: 0 }];
    while (pending.length) {
      const current = pending.pop();
      const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const itemPath = path.join(current.directory, entry.name);
        if (entry.isDirectory() && current.depth < root.depth) pending.push({ directory: itemPath, depth: current.depth + 1 });
        else if (entry.isFile()) {
          const stat = await fs.lstat(itemPath).catch(() => null);
          if (stat && staleTemporaryFile(entry.name, stat.mtimeMs, now, staleMs)) candidates.push({ path: itemPath, modifiedAt: new Date(stat.mtimeMs).toISOString(), ageMs: now - stat.mtimeMs });
        }
      }
    }
  }
  return candidates;
}

async function reapStaleTemporaryFiles() {
  const candidates = await staleTemporaryFilePlan();
  const removed = [];
  for (const candidate of candidates) {
    const stat = await fs.lstat(candidate.path).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || !staleTemporaryFile(path.basename(candidate.path), stat.mtimeMs, Date.now(), resourceBudget().temporaryFileRetentionMs)) continue;
    await fs.rm(candidate.path, { force: true });
    removed.push(candidate.path);
  }
  if (removed.length) await appendAudit('sandbox.cleanup.temporary_files_removed', { count: removed.length });
  return removed;
}

async function staleLockPlan() {
  const staleMs = resourceBudget().staleLockMs;
  const entries = await fs.readdir(LOCK_ROOT, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const now = Date.now();
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const lockPath = path.join(LOCK_ROOT, entry.name);
    const stat = await fs.stat(lockPath).catch(() => null);
    if (!stat) continue;
    let owner = null;
    try { owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')); } catch { /* an old lock may not have completed its owner write */ }
    const alive = owner ? ownerIsAlive(owner) : null;
    if (staleLockIsReapable(alive, stat.mtimeMs, now, staleMs)) candidates.push({ digest: entry.name, ownerPid: Number.isInteger(owner?.pid) ? owner.pid : null, ageMs: now - stat.mtimeMs });
  }
  return candidates;
}

async function reapStaleLocks() {
  const candidates = await staleLockPlan();
  const removed = [];
  const budget = resourceBudget();
  for (const candidate of candidates) {
    await withDurableLocks(LOCK_ROOT, [`reaper:${candidate.digest}`], async () => {
      const lockPath = path.join(LOCK_ROOT, candidate.digest);
      const stat = await fs.stat(lockPath).catch(() => null);
      if (!stat) return;
      let owner = null;
      try { owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')); } catch { /* stale ownerless lock */ }
      const alive = owner ? ownerIsAlive(owner) : null;
      if (!staleLockIsReapable(alive, stat.mtimeMs, Date.now(), budget.staleLockMs)) return;
      await fs.rm(lockPath, { recursive: true, force: true });
      removed.push(candidate.digest);
    }, { timeoutMs: Math.min(budget.lockTimeoutMs, 1000), staleLockMs: budget.staleLockMs }).catch((error) => {
      if (!String(error?.message ?? '').startsWith('SANDBOX_BUSY')) throw error;
    });
  }
  if (removed.length) await appendAudit('sandbox.cleanup.stale_locks_removed', { count: removed.length });
  return removed;
}

async function cleanupPlan() {
  const records = await readWorkloadRecords();
  const budget = resourceBudget();
  const items = [];
  for (const record of records) {
    if (record.workloadType !== 'task' || record.status === 'removed') continue;
    const executions = await listExecutionRecords(record.id);
    const decision = cleanupEligibility(record, Date.now(), budget.taskRetentionMs, executions);
    items.push({ sandboxId: record.id, repositoryId: record.repositoryId, worktreeId: record.worktreeId ?? null, status: record.status, createdAt: record.createdAt, ...decision });
  }
  const recordById = new Map(records.map((record) => [record.id, record]));
  let containerInventory;
  try { containerInventory = { available: true, containers: await listManagedContainers() }; }
  catch { containerInventory = { available: false, errorCode: 'container_inventory_unavailable', containers: [] }; }
  const orphanCandidates = [];
  const orphanSkipped = [];
  for (const container of containerInventory.containers) {
    let record = null;
    try {
      if (container.workloadId) record = recordById.get(safeId(container.workloadId)) ?? null;
      if (container.repositoryId) safeRepositoryId(container.repositoryId);
      if (container.worktreeId) safeId(container.worktreeId);
    } catch { orphanSkipped.push({ containerId: container.containerId, reason: 'invalid_managed_container_labels' }); continue; }
    const decision = orphanContainerEligibility(container, record, Date.now(), budget.taskRetentionMs);
    const item = { ...container, ...decision };
    if (!container.workloadId || !container.repositoryId || (container.workloadType === 'task' && !container.worktreeId)) {
      orphanSkipped.push({ containerId: container.containerId, reason: 'incomplete_managed_container_labels' });
    } else if (decision.eligible) orphanCandidates.push(item);
    else orphanSkipped.push(item);
  }
  return {
    generatedAt: new Date().toISOString(), retentionMs: budget.taskRetentionMs,
    candidates: items.filter((item) => item.eligible), skipped: items.filter((item) => !item.eligible),
    orphanContainers: { ...containerInventory, candidates: orphanCandidates, skipped: orphanSkipped },
    staleLocks: await staleLockPlan(), temporaryFiles: await staleTemporaryFilePlan(),
  };
}

async function runCleanup({ dryRun = true, confirm = false } = {}) {
  const plan = await cleanupPlan();
  if (dryRun) return { dryRun: true, ...plan };
  assert(confirm, 'Cleanup requires confirm=true');
  const removed = [];
  for (const candidate of plan.candidates) {
    await withDurableLocks(LOCK_ROOT, [`workload:${candidate.sandboxId}`], async () => {
      const record = await readRecord(candidate.sandboxId);
      const executions = await listExecutionRecords(record.id);
      const decision = cleanupEligibility(record, Date.now(), resourceBudget().taskRetentionMs, executions);
      if (!decision.eligible) return;
      const runtimeId = await resolveRuntimeId(record);
      if (runtimeId) {
        const state = await inspectContainerState(runtimeId);
        assert(['missing', 'exited', 'created', 'configured', 'stopped'].includes(state), 'Cleanup refused to remove a non-terminal task sandbox');
        if (state !== 'missing') await runPodman(['rm', '--force', runtimeId], 30_000);
      }
      const updated = { ...record, status: 'removed', runtimeId: null, removedAt: new Date().toISOString(), removalReason: 'expired_task_sandbox_cleanup', updatedAt: new Date().toISOString() };
      await writeRecord(updated);
      removed.push(candidate.sandboxId);
      await appendAudit('sandbox.cleanup.removed', { sandboxId: candidate.sandboxId, repositoryId: candidate.repositoryId });
    });
  }
  const orphanRemoved = [];
  for (const candidate of plan.orphanContainers.candidates) {
    await withDurableLocks(LOCK_ROOT, ['resource:global', `workload:${candidate.workloadId}`], async () => {
      const currentRecords = await readWorkloadRecords();
      const currentRecord = currentRecords.find((record) => record.id === candidate.workloadId);
      if (currentRecord && currentRecord.status !== 'removed') return;
      const containers = await listManagedContainers();
      const current = containers.find((item) => item.containerId === candidate.containerId && item.workloadId === candidate.workloadId);
      if (!current || current.workloadType !== 'task') return;
      const decision = orphanContainerEligibility(current, currentRecord, Date.now(), resourceBudget().taskRetentionMs);
      if (!decision.eligible) return;
      let state = current.state;
      if (currentRecord?.status === 'removed' && !['missing', 'exited', 'created', 'configured', 'stopped'].includes(state)) {
        await runPodman(['stop', '--time', '5', current.containerId], 15_000).catch(async () => { await runPodman(['kill', current.containerId], 15_000).catch(() => {}); });
        state = await inspectContainerState(current.containerId);
      }
      assert(['missing', 'exited', 'created', 'configured', 'stopped'].includes(state), 'Orphan cleanup refused to remove a running or unknown task container');
      if (state !== 'missing') await runPodman(['rm', '--force', current.containerId], 30_000);
      orphanRemoved.push(current.containerId);
      await appendAudit('sandbox.cleanup.orphan_container_removed', { workloadId: current.workloadId, repositoryId: current.repositoryId, containerId: current.containerId });
    });
  }
  const staleLocksRemoved = await reapStaleLocks();
  const temporaryFilesRemoved = await reapStaleTemporaryFiles();
  return { dryRun: false, removed, orphanRemoved, orphanInventory: { available: plan.orphanContainers.available, errorCode: plan.orphanContainers.errorCode ?? null }, staleLocksRemoved, temporaryFilesRemoved, skipped: plan.skipped, orphanSkipped: plan.orphanContainers.skipped };
}

async function listWorkspaceWriteLeases() {
  await fs.mkdir(WORKSPACE_WRITE_LEASE_ROOT, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const active = [];
  for (const name of await fs.readdir(WORKSPACE_WRITE_LEASE_ROOT)) {
    if (!UUID.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
    const file = path.join(WORKSPACE_WRITE_LEASE_ROOT, name);
    try {
      const lease = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= now) {
        await fs.rm(file, { force: true });
        continue;
      }
      active.push(lease);
    } catch {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }
  return active;
}

async function beginWorkspaceWrite(request) {
  const workspacePaths = ['/var/lib/vps-mcp/task-workspaces/worktrees', '/srv/vps-mcp-workspaces'];
  let workspacePath;
  for (const root of workspacePaths) {
    const candidate = expectedTaskWorkspacePath(root, request.repositoryId, request.worktreeId);
    try { if ((await fs.stat(candidate)).isDirectory()) { workspacePath = candidate; break; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert(workspacePath, 'Managed task workspace is unavailable');
  await fs.mkdir(WORKSPACE_WRITE_LEASE_ROOT, { recursive: true, mode: 0o700 });
  const leaseId = randomUUID();
  const expiresAt = new Date(Date.now() + WORKSPACE_WRITE_LEASE_TTL_MS).toISOString();
  await fs.writeFile(path.join(WORKSPACE_WRITE_LEASE_ROOT, `${leaseId}.json`), JSON.stringify({ leaseId, repositoryId: request.repositoryId, worktreeId: request.worktreeId, expiresAt }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await appendAudit('workspace.write.started', { repositoryId: request.repositoryId, worktreeId: request.worktreeId });
  return { leaseId, expiresAt };
}

async function finishWorkspaceWrite(leaseId) {
  await fs.rm(path.join(WORKSPACE_WRITE_LEASE_ROOT, `${safeId(leaseId)}.json`), { force: true });
  return { released: true };
}

async function waitForWorkspaceWritesToDrain() {
  const deadline = Date.now() + WORKSPACE_WRITE_LEASE_TTL_MS + 1000;
  while (Date.now() < deadline) {
    const leases = await listWorkspaceWriteLeases();
    if (leases.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('SANDBOX_WORKSPACE_WRITES_BUSY: emergency pause is active; waiting for in-flight workspace writes to finish');
}

async function setMaintenancePause(paused) {
  const state = { paused, updatedAt: new Date().toISOString(), reason: paused ? 'operator_emergency_pause' : null };
  await writeJsonAtomic(MAINTENANCE_FILE, state);
  await appendAudit(paused ? 'maintenance.paused' : 'maintenance.resumed');
  if (paused) await waitForWorkspaceWritesToDrain();
  return state;
}

async function stopTaskSandboxForSafety(record, reason, details = {}) {
  let stopped = false;
  const runtimeId = await resolveRuntimeId(record);
  if (!runtimeId) stopped = true;
  else {
    try {
      await runPodman(['stop', '--time', '5', runtimeId], 15_000);
      stopped = true;
    } catch {
      await runPodman(['kill', runtimeId], 15_000).catch(() => {});
      const state = await inspectContainerState(runtimeId);
      stopped = ['missing', 'exited', 'created', 'configured', 'stopped'].includes(state);
    }
  }
  const timestamp = new Date().toISOString();
  if (!stopped) {
    await writeRecord({ ...record, status: 'unknown', diskQuotaExceededAt: timestamp, diskQuotaReason: `${reason}_stop_failed`, updatedAt: timestamp });
    await appendAudit('sandbox.disk_quota.stop_failed', { sandboxId: record.id, repositoryId: record.repositoryId, reason });
    return false;
  }
  await cancelActiveSandboxExecutions(record.id, reason).catch(() => {});
  await markActiveExecutionsInterrupted(record.id, reason).catch(() => {});
  await writeRecord({ ...record, status: 'stopped', stoppedAt: timestamp, diskQuotaExceededAt: timestamp, diskQuotaReason: reason, ...details, updatedAt: timestamp });
  await appendAudit('sandbox.disk_quota.enforced', { sandboxId: record.id, repositoryId: record.repositoryId, reason, ...details });
  return true;
}

async function enforceHostDiskPressure() {
  const budget = resourceBudget();
  const disk = await diskStatus();
  if (disk.level !== 'critical') return;
  const records = await readWorkloadRecords();
  let stoppedTasks = 0;
  for (const record of records) {
    if (record.workloadType !== 'task' || record.status !== 'running') continue;
    await withDurableLocks(LOCK_ROOT, [`workload:${record.id}`], async () => {
      const current = await readRecord(record.id);
      if (current.workloadType !== 'task' || current.status !== 'running') return;
      if (await stopTaskSandboxForSafety(current, 'host_disk_critical', { hostFreeDiskBytes: disk.freeBytes })) stoppedTasks += 1;
    });
  }
  if (stoppedTasks) await appendAudit('host.disk_pressure.critical', { freeDiskBytes: disk.freeBytes, reserveBytes: budget.diskReserveBytes, stoppedTasks }).catch(() => {});
}

async function enforceWorkspaceDiskQuotas() {
  const records = await readWorkloadRecords();
  for (const record of records) {
    if (record.workloadType !== 'task' || record.status !== 'running' || !record.workspaceMount?.path) continue;
    await withDurableLocks(LOCK_ROOT, [`workload:${record.id}`], async () => {
      const current = await readRecord(record.id);
      if (current.workloadType !== 'task' || current.status !== 'running' || !current.workspaceMount?.path) return;
      const limitBytes = (current.resources?.diskMiB ?? 2048) * 1024 ** 2;
      let usageBytes;
      try { usageBytes = await sumRegularFileBytes(current.workspaceMount.path); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        const errorCode = message.match(/^[A-Z][A-Z0-9_]+(?=:)/)?.[0] ?? 'disk_scan_failed';
        await appendAudit('sandbox.disk_check.failed', { sandboxId: current.id, errorCode }).catch(() => {});
        await stopTaskSandboxForSafety(current, 'disk_usage_scan_failed');
        return;
      }
      if (usageBytes <= limitBytes) return;
      await stopTaskSandboxForSafety(current, 'disk_quota_exceeded', { diskUsageBytes: usageBytes, diskLimitBytes: limitBytes });
    });
  }
}

async function reapExpiredSandboxes() {
  try {
    await enforceHostDiskPressure();
    await enforceWorkspaceDiskQuotas();
    if ((await maintenanceState()).paused) return;
    await reapStaleLocks();
    await reapStaleTemporaryFiles();
    if (process.env.VPS_SANDBOX_CLEANUP_ENABLED === 'true') await runCleanup({ dryRun: false, confirm: true });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    const errorCode = message.match(/^[A-Z][A-Z0-9_]+(?=:)/)?.[0] ?? 'operation_failed';
    await appendAudit('sandbox.cleanup.failed', { errorCode }).catch(() => {});
  }
}

function isContainerNotFound(error) {
  const message = `${error?.stderr ?? ''} ${error?.message ?? ''}`;
  return /no such (?:container|object)|no container with name or id|no container found|container .* not found/i.test(message);
}

async function inspectContainerState(runtimeId) {
  try { return (await runPodman(['inspect', '--format', '{{.State.Status}}', runtimeId], 10_000)).stdout.trim().toLowerCase(); }
  catch (error) {
    if (isContainerNotFound(error)) return 'missing';
    throw new Error('SANDBOX_RUNTIME_UNAVAILABLE: container inspection failed; workload state was not changed');
  }
}

async function verifyRuntimeContainerIdentity(record, runtimeId) {
  let labels;
  try {
    const result = await runPodman(['inspect', '--format', '{{json .Config.Labels}}', runtimeId], 10_000);
    labels = parseContainerLabels(JSON.parse(result.stdout || '{}'));
  } catch (error) {
    if (isContainerNotFound(error)) return false;
    throw new Error('SANDBOX_RUNTIME_UNAVAILABLE: managed container identity inspection failed');
  }
  assert(labels['io.cr8or.vps-mcp.workload'] === record.id, 'SANDBOX_WORKLOAD_IDENTITY_MISMATCH: workload label does not match its record');
  assert(labels['io.cr8or.vps-mcp.type'] === record.workloadType, 'SANDBOX_WORKLOAD_IDENTITY_MISMATCH: workload type label does not match its record');
  assert(labels['io.cr8or.vps-mcp.repository'] === record.repositoryId, 'SANDBOX_WORKLOAD_IDENTITY_MISMATCH: repository label does not match its record');
  assert((labels['io.cr8or.vps-mcp.worktree'] ?? null) === (record.worktreeId ?? null), 'SANDBOX_WORKLOAD_IDENTITY_MISMATCH: worktree label does not match its record');
  if (record.workloadType === 'project-service') assert(labels['io.cr8or.vps-mcp.release'] === record.releaseId, 'SANDBOX_WORKLOAD_IDENTITY_MISMATCH: release label does not match its record');
  return true;
}

async function resolveRuntimeId(record) {
  if (record.runtimeId) {
    const valid = await verifyRuntimeContainerIdentity(record, record.runtimeId);
    if (valid) return record.runtimeId;
  }
  let id;
  try {
    const result = await runPodman(['inspect', '--format', '{{.Id}}', `vps-wl-${record.id}`]);
    id = result.stdout.trim().toLowerCase();
  } catch (error) {
    if (isContainerNotFound(error)) return null;
    throw new Error('SANDBOX_RUNTIME_UNAVAILABLE: workload container lookup failed');
  }
  if (!/^[a-f0-9]{12,64}$/.test(id ?? '')) return null;
  const valid = await verifyRuntimeContainerIdentity(record, id);
  return valid ? id : null;
}

function commandFingerprint(command) {
  return createHash('sha256').update(JSON.stringify(command ?? null)).digest('hex');
}
export function buildPodmanEnvironment(runtimeEnvironment = process.env) {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/var/lib/vps-sandbox',
    // Preserve the runtime service's writable temporary directory for image pulls.
    TMPDIR: runtimeEnvironment.TMPDIR ?? '/var/tmp',
    XDG_RUNTIME_DIR: runtimeEnvironment.XDG_RUNTIME_DIR ?? '',
    DBUS_SESSION_BUS_ADDRESS: runtimeEnvironment.DBUS_SESSION_BUS_ADDRESS ?? '',
    ...(restrictedTaskEgressEnabled() ? { HTTP_PROXY: EGRESS_PROXY_HOST, HTTPS_PROXY: EGRESS_PROXY_HOST, http_proxy: EGRESS_PROXY_HOST, https_proxy: EGRESS_PROXY_HOST, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' } : {}),
  };
}
async function runPodman(args, timeout = DEFAULT_TIMEOUT_MS, maxBuffer = MAX_RESPONSE_BYTES) {
  const { stdout, stderr } = await execFileAsync(PODMAN, ['--cgroup-manager=cgroupfs', ...args], {
    encoding: 'utf8', timeout, maxBuffer,
    env: buildPodmanEnvironment(),
  });
  return { stdout: stdout ?? '', stderr: stderr ?? '' };
}
export function assertWorkloadTypeMatch(record, expectedWorkloadType) {
  assert(expectedWorkloadType === record.workloadType, 'Workload type mismatch; refusing cross-lifecycle operation');
}
export function buildContainerCreateArgs({ id, workloadType, repositoryId, worktreeId, image, resources, workspaceMount, projectMounts, executionMount, command, network = 'none', podName, proxyUrl, restartPolicy }) {
  assert(workloadType !== 'task' || (executionMount?.destination === '/run/vps-mcp-executions' && path.isAbsolute(executionMount.path)), 'Task workloads require a dedicated execution log mount');
  assert(network === 'none' || (workloadType === 'task' && network === 'slirp4netns:allow_host_loopback=true' && proxyUrl === EGRESS_PROXY_CONTAINER), 'Unsupported workload network policy');
  assert(workloadType !== 'project-service' || (executionMount == null && projectMounts && projectMounts.releaseId && podName === projectPodName(repositoryId)), 'Project-service workloads require broker-staged mounts and their repository-private pod');
  assert(workloadType !== 'task' || (projectMounts == null && podName === undefined), 'Task workloads cannot join project pods or receive project-service mounts');
  return [
    'create', '--pull=never', ...(workloadType === 'project-service' ? [] : ['--cgroup-parent', CGROUP_PARENT]), '--name', `vps-wl-${id}`,
    ...labels(id, workloadType, repositoryId, worktreeId),
    ...(workloadType === 'project-service' ? ['--label', 'io.cr8or.vps-mcp.release=' + projectMounts.releaseId, '--label', 'io.cr8or.vps-mcp.pod=' + podName, '--restart=' + safeRestartPolicy(restartPolicy)] : []),
    ...(workloadType === 'project-service' ? buildProjectPodMemberArgs(podName) : ['--network=' + network]), '--http-proxy=false', '--read-only', '--cap-drop=ALL',
    ...(workloadType === 'project-service' ? ['--userns=keep-id:uid=10001,gid=10001', '--user', '10001:10001'] : ['--userns=keep-id', '--user', String(process.getuid()) + ':' + String(process.getgid())]),
    '--security-opt=no-new-privileges', '--security-opt=seccomp=/usr/share/containers/seccomp.json', '--pids-limit', String(resources.pids),
    '--memory', `${resources.memoryMiB}m`, `--memory-swap=${resources.memoryMiB * (workloadType === 'project-service' ? 1 : 2)}m`, '--cpus', String(resources.cpuMilli / 1000),
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
    ...(workspaceMount ? ['--mount', 'type=bind,src=' + (workspaceMount.stagedPath ?? workspaceMount.path) + ',dst=/workspace,' + (workspaceMount.access === 'read-only' ? 'ro' : 'rw')] : []),
    ...(projectMounts ? [
      '--mount', 'type=bind,src=' + projectMounts.release + ',dst=/app,ro',
      '--mount', 'type=bind,src=' + projectMounts.storage + ',dst=/app/storage,rw',
      '--mount', 'type=bind,src=' + projectMounts.cache + ',dst=/app/bootstrap/cache,rw',
      '--mount', 'type=bind,src=' + projectMounts.logs + ',dst=/app/storage/logs,rw',
    ] : []),
    ...(executionMount ? ['--mount', `type=bind,src=${executionMount.path},dst=/run/vps-mcp-executions,rw`] : []),
    ...(proxyUrl ? [
      '--env', `HTTP_PROXY=${proxyUrl}`,
      '--env', `HTTPS_PROXY=${proxyUrl}`,
      '--env', `http_proxy=${proxyUrl}`,
      '--env', `https_proxy=${proxyUrl}`,
      '--env', 'NO_PROXY=localhost,127.0.0.1,::1',
      '--env', 'no_proxy=localhost,127.0.0.1,::1',
    ] : []),
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
  if (request.resources) assert(Object.keys(request.resources).every((key) => ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB'].includes(key)), 'Resource configuration contains unsupported properties');
  const resources = safeResources({ ...request.resources, diskMiB: request.resources?.diskMiB ?? (workloadType === 'task' ? 2048 : 10240) });
  const reservationResources = workloadType === 'project-service' ? safeResources(request.reservationResources) : null;
  if (workloadType === 'task') {
    assert(request.worktreeId, 'Task workloads require a managed worktree ID');
    assert(request.workspacePath, 'Task workloads require their assigned workspace path');
  } else {
    assert(request.workspacePath === undefined && request.workspaceAccess === undefined, 'Project-service mounts are provisioned by the project environment manager');
    assert(request.projectMounts && request.projectMounts.releaseId === request.releaseId, 'Project-service mounts must be staged by the restricted broker');
    const mountRoot = '/var/lib/vps-sandbox-mounts/projects/' + repositoryId + '/' + id;
    for (const [key, suffix] of Object.entries({ release: 'release', storage: 'storage', cache: 'cache', logs: 'logs' })) {
      assert(request.projectMounts[key] === mountRoot + '/' + suffix, 'Project-service mount path is not canonical');
    }
  }
  const workspaceMount = request.workspacePath === undefined ? null : await resolveWorkspaceMount(request.workspacePath, request.workspaceAccess ?? 'read-only', repositoryId, worktreeId);
  const executionMount = workloadType === 'task' ? await ensureExecutionLogDirectory(id) : null;
  const egressEnabled = workloadType === 'task' && restrictedTaskEgressEnabled();
  const network = egressEnabled ? 'slirp4netns:allow_host_loopback=true' : 'none';
  const networkPolicy = workloadType === 'task' ? (egressEnabled ? 'task-restricted-egress' : 'task-no-egress') : 'project-private-no-egress';
  const podName = workloadType === 'project-service' ? request.podName : undefined;
  if (workloadType === 'project-service') assert(podName === projectPodName(repositoryId), 'Project-service workload must join its repository-private pod');
  assert(request.network === undefined || request.network === 'none', 'Only network=none is supported by this runtime adapter');
  assert(request.readOnlyRootfs === undefined || request.readOnlyRootfs === true, 'Container root filesystem must be read-only');
  const restartPolicy = workloadType === 'project-service' ? safeRestartPolicy(request.restartPolicy) : 'no';
  const fingerprint = commandFingerprint(request.command);
  const existing = await readRecord(id).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  let retryRecord = null;
  if (existing) {
    assert(
      existing.repositoryId === repositoryId &&
      existing.workloadType === workloadType &&
      existing.image === image &&
      (existing.restartPolicy ?? (workloadType === 'project-service' ? 'unless-stopped' : 'no')) === restartPolicy &&
      existing.worktreeId === worktreeId &&
      JSON.stringify(existing.workspaceMount ?? null) === JSON.stringify(workspaceMount) &&
      JSON.stringify(existing.executionMount ?? null) === JSON.stringify(executionMount) &&
      JSON.stringify(existing.projectMounts ?? null) === JSON.stringify(request.projectMounts ?? null) &&
      existing.podName === podName &&
      JSON.stringify(existing.reservationResources ?? existing.resources) === JSON.stringify(reservationResources ?? existing.resources) &&
      JSON.stringify({ ...existing.resources, diskMiB: existing.resources?.diskMiB ?? (workloadType === 'task' ? 2048 : 10240) }) === JSON.stringify(resources) &&
      existing.commandFingerprint === fingerprint,
      'Workload ID is already registered with different immutable attributes',
    );
    assert(existing.network === network, 'Existing workload network mode is immutable; recreate the task sandbox to change its egress profile');
    assert(existing.networkPolicy === undefined || existing.networkPolicy === networkPolicy, 'Existing workload network policy does not match the requested workload type');
    const normalized = { ...existing, resources, network, networkPolicy, restartPolicy };
    const replayRuntimeId = existing.status === 'removed' ? null : await resolveRuntimeId(normalized);
    const runtimeState = replayRuntimeId ? await inspectContainerState(replayRuntimeId) : 'missing';
    const replay = createWorkloadReplayDecision(existing, runtimeState);
    if (replay.action === 'replay_removed') return { ...normalized, reused: true };
    if (replay.action === 'reconcile') {
      const status = runtimeState === 'running' ? 'running' : ['exited', 'stopped'].includes(runtimeState) ? 'stopped' : ['created', 'configured'].includes(runtimeState) ? 'created' : 'unknown';
      const reconciled = { ...normalized, runtimeId: replayRuntimeId, status, updatedAt: new Date().toISOString() };
      await writeRecord(reconciled);
      return { ...reconciled, reused: true };
    }
    if (replay.action === 'retry_create') {
      const { error: _previousError, ...prior } = normalized;
      retryRecord = { ...prior, runtimeId: null, status: 'creating', expiresAt: workloadType === 'task' ? new Date(Date.now() + resourceBudget().taskRetentionMs).toISOString() : null, updatedAt: new Date().toISOString() };
    } else {
      const unknown = { ...normalized, runtimeId: replayRuntimeId ?? normalized.runtimeId ?? null, status: 'unknown', updatedAt: new Date().toISOString() };
      await writeRecord(unknown);
      throw new Error('SANDBOX_RUNTIME_UNAVAILABLE: existing workload container is missing; record retained for operator review');
    }
  }


  const currentRecords = (await readWorkloadRecords()).filter((item) => item.id !== id);
  await assertManagedContainerAccounting(currentRecords);
  if (workloadType === 'project-service') await assertProjectContainersAccounted(repositoryId, currentRecords);
  const reservations = await readReservations();
  const disk = await diskStatus();
  const capacity = evaluateResourceRequest({ records: currentRecords, reservations, requested: { workloadType, repositoryId, worktreeId, resources }, budget: resourceBudget(), freeDiskBytes: disk.freeBytes });
  assert(capacity.allowed, capacity.reasons.join('; '));
  if (workloadType === 'task') await applyWorkspaceDiskQuota(repositoryId, worktreeId, resources.diskMiB);
  let record = retryRecord ?? {
    id, workloadType, repositoryId, ...(worktreeId ? { worktreeId } : {}), ...(podName ? { podName } : {}), ...(reservationResources ? { reservationResources } : {}),
    image, imageDigest: image.slice(image.lastIndexOf('@') + 1), restartPolicy,
    runtimeId: null, workspaceMount, executionMount, ...(request.projectMounts ? { projectMounts: request.projectMounts } : {}), ...(request.releaseId ? { releaseId: request.releaseId } : {}), resources, network, networkPolicy, commandFingerprint: fingerprint,
    status: 'creating', createdAt: new Date().toISOString(), expiresAt: workloadType === 'task' ? new Date(Date.now() + resourceBudget().taskRetentionMs).toISOString() : null, updatedAt: new Date().toISOString(),
  };
  await writeRecord(record);
  try {
    const stagedWorkspacePath = workloadType === 'task' ? await stageWorkspaceMount(repositoryId, worktreeId, id) : null;
    if (stagedWorkspacePath) { record = { ...record, stagedWorkspacePath }; await writeRecord(record); }
    const args = buildContainerCreateArgs({
      id, workloadType, repositoryId, worktreeId, image, resources, workspaceMount: workspaceMount ? { ...workspaceMount, stagedPath: stagedWorkspacePath } : null, projectMounts: request.projectMounts, executionMount, command: request.command, network, proxyUrl: egressEnabled ? EGRESS_PROXY_CONTAINER : undefined, restartPolicy,
    });
    const result = await runPodman(args, 120_000);
    const runtimeId = result.stdout.trim().split(/\s+/)[0];
    assert(/^[a-f0-9]{12,64}$/i.test(runtimeId ?? ''), 'Podman returned an invalid container ID');
    const completed = { ...record, runtimeId, status: 'created', updatedAt: new Date().toISOString() };
    await writeRecord(completed);
    await appendAudit('sandbox.created', { sandboxId: id, workloadType, repositoryId, worktreeId, resources });
    return completed;
  } catch (error) {
    const failed = { ...record, status: 'error', error: error instanceof Error ? error.message.slice(0, 500) : 'Runtime create failed', updatedAt: new Date().toISOString() };
    await writeRecord(failed);
    throw error;
  }
}
async function verifyProjectServiceMounts(projectMounts, repositoryId, workloadId) {
  const base = '/var/lib/vps-sandbox-mounts/projects/' + repositoryId + '/' + workloadId;
  const expectedSources = expectedProjectServiceMountSources(repositoryId, projectMounts.releaseId);
  for (const [key, suffix, readOnly] of [
    ['release', 'release', true], ['storage', 'storage', false], ['cache', 'cache', false], ['logs', 'logs', false],
  ]) {
    const target = base + '/' + suffix;
    assert(projectMounts[key] === target, 'Project-service mount path is not canonical');
    const mountedSource = path.resolve((await execFileAsync('/usr/bin/findmnt', ['-n', '-o', 'FSROOT', '--mountpoint', target], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192 })).stdout.trim());
    assert(expectedSources.filter((sources) => sources[key] === mountedSource).length === 1,
      'Project-service mount source does not match exactly one configured canonical repository and release root');
    const stat = await fs.lstat(target);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && await fs.realpath(target) === target, 'Project-service mount target is not a canonical directory');
    await execFileAsync('/usr/bin/mountpoint', ['-q', target], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
    const mountResult = await execFileAsync('/usr/bin/findmnt', ['-n', '-o', 'OPTIONS', '--mountpoint', target], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
    const options = mountResult.stdout.trim().split(',');
    assert(readOnly ? options.includes('ro') : !options.includes('ro'), readOnly ? 'Project release mount must be read-only' : 'Project data mount must be writable');
    assert(options.includes('nosuid') && options.includes('nodev'), 'Project mounts must enforce nosuid and nodev');
  }
}
async function inspectProjectPod(repositoryId) {
  const name = projectPodName(repositoryId);
  const result = await runPodman(['pod', 'inspect', '--format', '{{json .}}', name]);
  let raw;
  try { raw = JSON.parse(result.stdout.trim()); } catch { throw new Error('Podman returned invalid project pod inspection JSON'); }
  const pod = validateProjectPodInspection(raw, repositoryId);
  const infraResult = await runPodman(['inspect', '--format', '{{json .}}', pod.infraContainerId]);
  let infra;
  try { infra = JSON.parse(infraResult.stdout.trim()); } catch { throw new Error('Podman returned invalid project pod infra inspection JSON'); }
  validateProjectPodInfraInspection(infra, pod);
  return pod;
}

async function projectPodExists(repositoryId) {
  try {
    await runPodman(['pod', 'exists', projectPodName(repositoryId)], 10_000, 8192);
    return true;
  } catch (error) {
    if (error?.code === 1 || error?.code === '1') return false;
    throw error;
  }
}

async function ensureProjectPod(repositoryId) {
  const name = projectPodName(repositoryId);
  if (await projectPodExists(repositoryId)) return { ...(await inspectProjectPod(repositoryId)), created: false };
  try {
    await runPodman(buildProjectPodCreateArgs(repositoryId), 30_000);
  } catch (createError) {
    // If another operation won the create race, accept only a fully verified pod.
    if (await projectPodExists(repositoryId)) return { ...(await inspectProjectPod(repositoryId)), created: false };
    throw createError;
  }
  try { return { ...(await inspectProjectPod(repositoryId)), created: true }; }
  catch (verifyError) {
    await runPodman(['pod', 'rm', '--force', name], 30_000).catch(() => {});
    throw verifyError;
  }
}

async function verifyProjectServicePod(record, runtimeId) {
  assert(record.podName === projectPodName(record.repositoryId), 'Project-service pod identity does not match its repository');
  const pod = await inspectProjectPod(record.repositoryId);
  const memberResult = await runPodman(['inspect', '--format', '{{json .}}', runtimeId]);
  let member;
  try { member = JSON.parse(memberResult.stdout.trim()); } catch { throw new Error('Podman returned invalid project-service pod member inspection JSON'); }
  validateProjectPodMemberInspection(member, pod);
  return pod;
}

async function removeProjectPodIfEmpty(repositoryId) {
  const name = projectPodName(repositoryId);
  if (!(await projectPodExists(repositoryId))) return { removed: false, notFound: true };
  const pod = await inspectProjectPod(repositoryId);
  const members = pod.containers.filter((container) => container.id && container.id !== pod.infraContainerId);
  assert(members.length === 0, 'Project pod still contains workload containers; refusing to remove its private network namespace');
  const result = await runPodman(['pod', 'rm', '--force', name], 30_000);
  return { removed: true, output: result.stdout.trim() };
}

async function createProjectServiceWorkload(request) {
  const id = safeId(request.workloadId);
  const repositoryId = safeRepositoryId(request.repositoryId);
  const releaseId = safeId(request.releaseId);
  const image = safeImage(request.image);
  const resources = safeResources(request.resources);
  const reservationResources = safeResources(request.reservationResources);
  const restartPolicy = safeRestartPolicy(request.restartPolicy);
  const existing = await readRecord(id).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && existing.status !== 'removed') {
    assert(existing.workloadType === 'project-service' && existing.repositoryId === repositoryId && existing.releaseId === releaseId && existing.image === image && existing.restartPolicy === restartPolicy,
      'Project-service workload ID is already bound to different immutable attributes');
    assert(JSON.stringify({ ...existing.resources, diskMiB: existing.resources?.diskMiB ?? 10240 }) === JSON.stringify(resources),
      'Project-service resource reservation is immutable while its workload exists');
  }
  if (existing?.status === 'removed') {
    throw new Error('Removed project-service workload IDs are terminal; register a new project environment before provisioning again');
  }
  const reservation = (await readReservations()).find((item) => item.repositoryId === repositoryId && item.status !== 'released');
  assert(resourceReservationMatches(reservation, reservationResources),
    'SANDBOX_PROJECT_RESERVATION_MISMATCH: aggregate project resources must exactly match the active repository reservation');
  for (const key of ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB']) assert(resources[key] <= reservationResources[key],
    'SANDBOX_PROJECT_RESERVATION_EXCEEDED: application resources exceed the aggregate project reservation');
  let projectMounts = null;
  let projectPod = null;
  try {
    projectPod = await ensureProjectPod(repositoryId);
    await applyProjectEnvironmentDiskQuota(repositoryId, id, reservationResources.diskMiB);
    projectMounts = await stageProjectServiceMounts(repositoryId, id, releaseId);
    await verifyProjectServiceMounts(projectMounts, repositoryId, id);
    const workload = await createWorkload({
      operation: 'container.create', workloadId: id, workloadType: 'project-service', repositoryId,
      releaseId, projectMounts, image, resources, reservationResources, restartPolicy, command: request.command, network: 'none', podName: projectPod.name, readOnlyRootfs: true,
    });
    if (workload.runtimeId) {
      await verifyProjectServiceRestartPolicy(workload, workload.runtimeId);
      await verifyProjectServicePod(workload, workload.runtimeId);
    }
    await appendAudit('project-service.created', { workloadId: id, repositoryId, releaseId, imageDigest: image.slice(image.lastIndexOf('@') + 1), resources });
    return { workload };
  } catch (error) {
    const persisted = await readRecord(id).catch((readError) => readError.code === 'ENOENT' ? null : Promise.reject(readError));
    if (!persisted && projectMounts) await unstageProjectServiceMounts(repositoryId, id, releaseId).catch(() => {});
    if (!persisted && projectPod?.created) await removeProjectPodIfEmpty(repositoryId).catch(() => {});
    throw error;
  }
}
async function verifyProjectServiceRestartPolicy(record, runtimeId) {
  const result = await runPodman(['inspect', '--format', '{{.HostConfig.RestartPolicy.Name}}', runtimeId]);
  assert(result.stdout.trim() === record.restartPolicy, 'Project-service restart policy does not match its durable profile');
}
async function inspectProjectServiceWorkload(workloadId) {
  const record = await readRecord(workloadId);
  assert(record.workloadType === 'project-service', 'Project-service operation cannot target a task workload');
  if (record.status !== 'removed') await verifyProjectServiceMounts(record.projectMounts, record.repositoryId, record.id);
  const runtimeId = record.status === 'removed' ? null : await resolveRuntimeId(record);
  if (!runtimeId) return { workload: record, runtime: null, reconciliation: 'runtime container is missing; project-service record retained for operator review' };
  await verifyProjectServiceRestartPolicy(record, runtimeId);
  await verifyProjectServicePod(record, runtimeId);
  const result = await runPodman(['inspect', '--format', '{{json .State}}', runtimeId]);
  let runtime;
  try { runtime = JSON.parse(result.stdout.trim()); } catch { throw new Error('Podman returned invalid inspect JSON'); }
  const status = runtime.Status === 'running' ? 'running' : runtime.Status === 'exited' ? 'stopped' : record.status;
  const updated = { ...record, runtimeId, status, updatedAt: new Date().toISOString() };
  await writeRecord(updated);
  let health = { status: 'unknown', checkedAt: new Date().toISOString(), checks: [] };
  if (status === 'running') {
    try {
      const checked = await waitForProjectServiceHealth(
        () => runPodman(['exec', '--user', '10001:10001', runtimeId, ...projectServiceHealthProbeCommand()], 5000, 8192),
        { attempts: 1, intervalMs: 0 },
      );
      health = { status: checked.status, checkedAt: checked.checkedAt, checks: checked.checks };
    } catch {
      health = { status: 'unhealthy', checkedAt: new Date().toISOString(), checks: ['php-fpm'] };
    }
  }
  return { workload: updated, runtime, health };
}
export function projectServiceHealthProbeCommand() {
  return ['php', '-r', "$socket = @fsockopen('127.0.0.1', 9000, $errno, $errstr, 2); if (!is_resource($socket)) { fwrite(STDERR, 'PHP-FPM TCP health check failed'); exit(1); } fclose($socket);"];
}

export async function waitForProjectServiceHealth(probe, options = {}) {
  const attempts = options.attempts ?? 10;
  const intervalMs = options.intervalMs ?? 1000;
  assert(Number.isInteger(attempts) && attempts >= 1 && attempts <= 30, 'Health-check attempts must be between 1 and 30');
  assert(Number.isInteger(intervalMs) && intervalMs >= 0 && intervalMs <= 5000, 'Health-check interval must be between 0 and 5000ms');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await probe();
      return { status: 'healthy', checkedAt: new Date().toISOString(), checks: ['php-fpm'], attempts: attempt };
    } catch {
      if (attempt < attempts && intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error('Project-service PHP-FPM health check failed after ' + attempts + ' attempts');
}
export function validateProjectServiceCgroupV2Limits(values, resources) {
  const memory = /^\d+$/.test(values.memoryMax) ? BigInt(values.memoryMax) : null;
  const memorySwap = /^\d+$/.test(values.memorySwapMax) ? BigInt(values.memorySwapMax) : null;
  assert(memorySwap === 0n, 'Project-service cgroup memory.swap.max must be zero');
  assert(memory !== null && memory > 0n && memory <= BigInt(resources.memoryMiB) * 1024n * 1024n,
    'Project-service cgroup memory.max is missing, unbounded or exceeds its reservation');
  const cpu = values.cpuMax.trim().split(/\s+/);
  assert(cpu.length === 2 && /^\d+$/.test(cpu[0]) && /^\d+$/.test(cpu[1]),
    'Project-service cgroup cpu.max is missing or unbounded');
  const quota = BigInt(cpu[0]);
  const period = BigInt(cpu[1]);
  assert(quota > 0n && period > 0n && quota * 1000n <= BigInt(resources.cpuMilli) * period,
    'Project-service cgroup CPU quota exceeds its reservation');
  const pids = /^\d+$/.test(values.pidsMax) ? BigInt(values.pidsMax) : null;
  assert(pids !== null && pids > 0n && pids <= BigInt(resources.pids),
    'Project-service cgroup pids.max is missing, unbounded or exceeds its reservation');
  return { memoryMax: memory.toString(), cpuMax: cpu.join(' '), pidsMax: pids.toString() };
}
async function verifyProjectServiceCgroupV2Limits(runtimeId, resources) {
  const cgroupPath = (await runPodman(['inspect', '--format', '{{.State.CgroupPath}}', runtimeId])).stdout.trim();
  assert(cgroupPath && !cgroupPath.split('/').includes('..'), 'Podman did not report a safe project-service cgroup path');
  const cgroupRoot = '/sys/fs/cgroup';
  const target = path.resolve(cgroupRoot, cgroupPath.replace(/^\/+/, ''));
  assert(target.startsWith(cgroupRoot + path.sep), 'Project-service cgroup path escaped the cgroup v2 root');
  const realTarget = await fs.realpath(target);
  assert(realTarget === target, 'Project-service cgroup path is not canonical');
  const controllers = await fs.readFile(path.join(cgroupRoot, 'cgroup.controllers'), 'utf8');
  for (const controller of ['cpu', 'memory', 'pids']) assert(controllers.split(/\s+/).includes(controller), 'Required cgroup v2 controller is unavailable: ' + controller);
  const [memoryMax, memorySwapMax, cpuMax, pidsMax] = await Promise.all([
    fs.readFile(path.join(target, 'memory.max'), 'utf8'),
    fs.readFile(path.join(target, 'memory.swap.max'), 'utf8'),
    fs.readFile(path.join(target, 'cpu.max'), 'utf8'),
    fs.readFile(path.join(target, 'pids.max'), 'utf8'),
  ]);
  return validateProjectServiceCgroupV2Limits({ memoryMax: memoryMax.trim(), memorySwapMax: memorySwapMax.trim(), cpuMax: cpuMax.trim(), pidsMax: pidsMax.trim() }, resources);
}

async function startProjectServiceWorkload(workloadId) {
  const record = await readRecord(workloadId);
  assert(record.workloadType === 'project-service' && record.status !== 'removed', 'Project-service operation cannot target a removed or task workload');
  const reservations = await readReservations();
  const reservation = reservations.find((item) => item.repositoryId === record.repositoryId && item.status !== 'released');
  assert(resourceReservationMatches(reservation, record.reservationResources ?? record.resources), 'Project-service aggregate resource reservation is missing or does not match the workload');
  const projectMounts = await stageProjectServiceMounts(record.repositoryId, record.id, record.releaseId);
  await verifyProjectServiceMounts(projectMounts, record.repositoryId, record.id);
  const existingRuntimeId = record.runtimeId ?? await resolveRuntimeId(record);
  assert(existingRuntimeId, 'Project-service runtime container is missing; operator review is required');
  await verifyProjectServicePod(record, existingRuntimeId);
  const result = await mutate({ operation: 'container.start', workloadId, expectedWorkloadType: 'project-service' },
    (current) => runPodman(['pod', 'start', current.podName]));
  const startedRecord = result.workload ?? await readRecord(workloadId);
  const runtimeId = startedRecord.runtimeId;
  assert(runtimeId, 'Project-service runtime container identity is unavailable after start');
  try {
    const effectiveLimits = await verifyProjectServiceCgroupV2Limits(runtimeId, startedRecord.resources);
    await appendAudit('project-service.limits.verified', { workloadId, repositoryId: record.repositoryId, effectiveLimits });
    const health = await waitForProjectServiceHealth(
      () => runPodman(['exec', '--user', '10001:10001', runtimeId, ...projectServiceHealthProbeCommand()], 5000, 8192),
      { attempts: 10, intervalMs: 1000 },
    );
    await appendAudit('project-service.health.verified', { workloadId, repositoryId: record.repositoryId, checks: health.checks, attempts: health.attempts });
    return { ...result, health };
  } catch (error) {
    let stopFailure = null;
    try { await runPodman(['pod', 'stop', '--time', '1', startedRecord.podName], 30_000); }
    catch (stopError) { stopFailure = stopError instanceof Error ? stopError.message : 'stop failed'; }
    const latest = await readRecord(workloadId);
    await writeRecord({
      ...latest, status: 'error',
      error: ('Effective cgroup v2 resource limits were not enforced: ' + (error instanceof Error ? error.message : 'verification failed')
        + (stopFailure ? '; container stop also failed: ' + stopFailure : '')).slice(0, 500),
      updatedAt: new Date().toISOString(),
    });
    await appendAudit('project-service.limits.rejected', { workloadId, repositoryId: record.repositoryId, stopFailure: Boolean(stopFailure) });
    throw new Error('Project-service start rejected because effective cgroup v2 limits were not enforced' + (stopFailure ? ' and the container could not be stopped' : ''));
  }
}

async function removeProjectServiceWorkload(request) {
  const { workloadId, repositoryId, releaseId } = request;
  const record = await readRecord(workloadId).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!record) {
    const containers = await listManagedContainers();
    assert(!containers.some((container) => container.workloadId === workloadId || container.name === 'vps-wl-' + workloadId),
      'Project-service workload record is missing but a container with its identity still exists; operator reconciliation is required');
    await removeProjectPodIfEmpty(repositoryId);
    await unstageProjectServiceMounts(repositoryId, workloadId, releaseId);
    await appendAudit('project-service.removed-missing-record', { workloadId, repositoryId, releaseId });
    return { workload: null, removed: true, notFound: true };
  }
  assert(record.workloadType === 'project-service' && record.repositoryId === repositoryId && record.releaseId === releaseId,
    'Project-service removal identity does not match its persisted workload record');
  const result = await mutate({ operation: 'container.remove', workloadId, expectedWorkloadType: 'project-service' }, (current) => runPodman(['rm', '--force', current.runtimeId], 30_000));
  const podRemoval = await removeProjectPodIfEmpty(repositoryId);
  await releaseProjectServiceMounts(result.workload);
  await appendAudit('project-service.removed', { workloadId, repositoryId: record.repositoryId, releaseId, podRemoved: podRemoval.removed });
  return result;
}

async function mutate(request, action) {
  const record = await readRecord(request.workloadId);
  assertWorkloadTypeMatch(record, request.expectedWorkloadType);
  if (request.operation === 'container.start' && record.workloadType === 'project-service') await verifyProjectServiceMounts(record.projectMounts, record.repositoryId, record.id);
  if (request.operation === 'container.remove' && record.status === 'removed') return { workload: record, output: '' };
  assert(ACTIVE_STATES.has(record.status), 'Workload is not in a mutable lifecycle state');
  const runtimeId = await resolveRuntimeId(record);
  if (!runtimeId) {
    if (request.operation === 'container.remove') {
      const updatedAt = new Date().toISOString();
      await releaseWorkspaceMount(record);
      const removed = { ...record, status: 'removed', runtimeId: null, removedAt: updatedAt, updatedAt };
      await writeRecord(removed);
      await appendAudit('sandbox.removed', { sandboxId: removed.id, workloadType: removed.workloadType, repositoryId: removed.repositoryId, alreadyMissing: true });
      return { workload: removed, output: '' };
    }
    const missing = { ...record, status: 'unknown', updatedAt: new Date().toISOString() };
    await writeRecord(missing);
    throw new Error('Managed runtime container is missing; workload record retained for operator review');
  }
  const recovered = runtimeId === record.runtimeId ? record : { ...record, runtimeId, updatedAt: new Date().toISOString() };
  if (recovered !== record) await writeRecord(recovered);
  const current = await inspectContainerState(runtimeId);
  if (request.operation === 'container.start' && current === 'running') {
    const running = { ...recovered, status: 'running', updatedAt: new Date().toISOString() };
    await writeRecord(running);
    return { workload: running, output: '' };
  }
  if (request.operation === 'container.start' && current === 'paused') {
    const result = await runPodman(['unpause', runtimeId]);
    const updated = { ...recovered, status: 'running', updatedAt: new Date().toISOString() };
    await writeRecord(updated);
    await appendAudit('sandbox.started', { sandboxId: updated.id, workloadType: updated.workloadType, repositoryId: updated.repositoryId, resumed: true });
    return { workload: updated, output: result.stdout.trim() };
  }
  if (request.operation === 'container.stop' && ['missing', 'created', 'configured', 'exited', 'stopped'].includes(current)) {
    if (recovered.workloadType === 'task' && current !== 'missing') await markActiveExecutionsInterrupted(recovered.id, 'sandbox_stopped');
    const status = current === 'missing' ? 'unknown' : current === 'created' || current === 'configured' ? 'created' : 'stopped';
    const updatedAt = new Date().toISOString();
    const stopped = { ...recovered, status, ...(status === 'stopped' ? { stoppedAt: updatedAt } : {}), updatedAt };
    await writeRecord(stopped);
    const auditAction = status === 'unknown' ? 'sandbox.state.unknown' : status === 'created' ? 'sandbox.stop.noop' : 'sandbox.stopped';
    await appendAudit(auditAction, { sandboxId: stopped.id, workloadType: stopped.workloadType, repositoryId: stopped.repositoryId, runtimeState: current });
    return { workload: stopped, output: '' };
  }
  if (request.operation === 'container.remove' && current === 'missing') {
    const updatedAt = new Date().toISOString();
    await releaseWorkspaceMount(recovered);
    const removed = { ...recovered, status: 'removed', runtimeId: null, removedAt: updatedAt, updatedAt };
    await writeRecord(removed);
    await appendAudit('sandbox.removed', { sandboxId: removed.id, workloadType: removed.workloadType, repositoryId: removed.repositoryId, alreadyMissing: true });
    return { workload: removed, output: '' };
  }
  const allowedStates = request.operation === 'container.start' ? ['created', 'configured', 'exited', 'stopped']
    : request.operation === 'container.stop' ? ['running', 'paused']
    : ['running', 'paused', 'created', 'configured', 'exited', 'stopped'];
  assert(allowedStates.includes(current), `Managed runtime container is in an unsupported state for ${request.operation}: ${current}`);
  const intentStatus = request.operation === 'container.start' ? 'starting' : 'stopping';
  if (request.operation === 'container.stop' && recovered.workloadType === 'task') await cancelActiveSandboxExecutions(recovered.id, 'sandbox_stopped');
  await writeRecord({ ...recovered, status: intentStatus, updatedAt: new Date().toISOString() });
  const result = await action(recovered);
  if (request.operation === 'container.stop' && recovered.workloadType === 'task') await markActiveExecutionsInterrupted(recovered.id, 'sandbox_stopped');
  const status = request.operation === 'container.start' ? 'running'
    : request.operation === 'container.stop' ? 'stopped'
    : request.operation === 'container.remove' ? 'removed' : record.status;
  const updatedAt = new Date().toISOString();
  const updated = { ...recovered, status, ...(request.operation === 'container.stop' ? { stoppedAt: updatedAt } : {}), updatedAt };
  await writeRecord(updated);
  await appendAudit(`sandbox.${request.operation.slice('container.'.length)}`, { sandboxId: updated.id, workloadType: updated.workloadType, repositoryId: updated.repositoryId });
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
  const runtimeState = await inspectContainerState(runtimeId);
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
  const operationId = request.operationId ?? randomUUID();
  const sandboxId = safeId(request.sandboxId);
  const cwdRelative = request.cwd ?? '';
  const maxOutputBytes = request.maxOutputBytes ?? 262_144;
  const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fingerprint = createHash('sha256').update(JSON.stringify({ sandboxId, command: request.command, cwd: cwdRelative, timeout, maxOutputBytes, env: request.env ?? {} })).digest('hex');
  const existing = await readSandboxOperation(sandboxId, operationId);
  const replay = operationReplayDecision(existing, fingerprint);
  if (replay.action === 'conflict') throw new Error('SANDBOX_OPERATION_CONFLICT: operationId was already used with different command parameters');
  if (replay.action === 'busy') throw new Error('SANDBOX_BUSY: this operationId is already running');
  if (replay.action === 'unknown') throw new Error('SANDBOX_EXECUTION_UNKNOWN: the prior operation was interrupted; inspect the workspace before retrying with a new operationId');
  if (replay.action === 'replay') return { ...existing.result, operationId, reused: true };

  const { record, runtimeId } = await taskSandboxRecord(sandboxId);
  const activeExecutions = await listExecutionRecords(sandboxId);
  for (const item of activeExecutions) if (['starting', 'running', 'cancelling'].includes(item.status)) await refreshExecutionStatus(sandboxId, item.id);
  const reconciledExecutions = await listExecutionRecords(sandboxId);
  assert(!reconciledExecutions.some((item) => ['starting', 'running', 'cancelling', 'unknown'].includes(item.status)), 'SANDBOX_EXECUTION_BUSY: use execution status/logs/cancel while a background command is active');
  assert(runtimeId, 'Task sandbox runtime container is missing');
  await pruneSandboxOperations(sandboxId);
  const operation = { sandboxId, operationId, fingerprint, status: 'running', startedAt: new Date().toISOString() };
  await writeSandboxOperation(operation);
  await appendAudit('sandbox.exec.started', { sandboxId, operationId }).catch(() => {});
  let result;
  try {
    const args = buildSandboxExecArgs({ runtimeId, cwd: cwdRelative, command: request.command, env: request.env ?? {} });
    const podmanResult = await runPodman(args, timeout, maxOutputBytes + 1);
    const output = boundedSandboxOutput(podmanResult.stdout, podmanResult.stderr, maxOutputBytes);
    result = { sandboxId: record.id, cwd: cwdRelative, exitCode: 0, ...output, timedOut: false };
  } catch (error) {
    const failure = error;
    if (Number.isInteger(failure.code)) {
      const output = boundedSandboxOutput(failure.stdout ?? '', failure.stderr ?? '', maxOutputBytes);
      result = { sandboxId: record.id, cwd: cwdRelative, exitCode: failure.code, ...output, timedOut: false };
    } else if (failure.code === 'ETIMEDOUT' || failure.killed) {
      result = { sandboxId: record.id, cwd: cwdRelative, exitCode: null, ...boundedSandboxOutput(failure.stdout ?? '', failure.stderr ?? '', maxOutputBytes), timedOut: true };
    } else if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      result = { sandboxId: record.id, cwd: cwdRelative, exitCode: null, ...boundedSandboxOutput(failure.stdout ?? '', failure.stderr ?? '', maxOutputBytes), timedOut: false, truncated: true };
    } else {
      const failedResult = { sandboxId: record.id, operationId, cwd: cwdRelative, exitCode: null, stdout: '', stderr: '', timedOut: false, errorCode: 'execution_failed' };
      await writeSandboxOperation({ ...operation, status: 'failed', finishedAt: new Date().toISOString(), result: failedResult });
      await appendAudit('sandbox.exec.failed', { sandboxId, operationId, errorCode: 'execution_failed' }).catch(() => {});
      return { ...failedResult, operationId, reused: false };
    }
  }
  await writeSandboxOperation({ ...operation, status: 'completed', finishedAt: new Date().toISOString(), result });
  await appendAudit('sandbox.exec.completed', { sandboxId, operationId, exitCode: result.exitCode, timedOut: result.timedOut }).catch(() => {});
  return { ...result, operationId, reused: false };
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
    ? await inspectContainerState(runtimeId)
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
  const sandboxId = safeId(request.sandboxId);
  const command = safeArgv(request.command);
  const cwd = request.cwd ?? '';
  validateWorkspaceRelativePath(cwd, true);
  const timeoutMs = request.timeoutMs ?? EXECUTION_POLICY.defaultTimeoutMs;
  assert(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= EXECUTION_POLICY.maxTimeoutMs, 'timeoutMs is outside the allowed range');
  const executionId = request.executionId ? safeExecutionId(request.executionId) : randomUUID();
  const requestFingerprint = createHash('sha256').update(JSON.stringify({ command: executionCommandMetadata(command).fingerprint, cwd, timeoutMs })).digest('hex');
  const existingExecution = await readExecutionRecord(sandboxId, executionId).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existingExecution) {
    assert(existingExecution.requestFingerprint === requestFingerprint, 'SANDBOX_OPERATION_CONFLICT: executionId was already used with different command parameters');
    return { sandboxId, executionId, status: existingExecution.status, command: existingExecution.command, cwd: existingExecution.cwd,
      exitCode: existingExecution.exitCode, timeoutAt: existingExecution.timeoutAt, logLimitBytes: EXECUTION_POLICY.maxLogBytes, createdAt: existingExecution.createdAt, reused: true };
  }
  const { record: workload, runtimeId } = await taskSandboxRecord(sandboxId);
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
    await runPodman(['exec', runtimeId, 'sh', '-c', 'for tool in setsid env head mkfifo awk sed grep tr sleep date ps; do command -v $tool >/dev/null 2>&1 || exit 127; done; ulimit -f 4097 >/dev/null 2>&1 || exit 127; test -d /run/vps-mcp-executions && test -w /run/vps-mcp-executions && test -r /proc/self/stat'], 10_000, 16 * 1024);
    const execution = createExecutionRecord({ sandboxId: workload.id, runtimeId, command, cwd, timeoutMs, id: executionId, requestFingerprint });
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
      exitCode: refreshed.exitCode, timeoutAt: execution.timeoutAt, logLimitBytes: EXECUTION_POLICY.maxLogBytes, createdAt: execution.createdAt, reused: false };
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


async function readCgroupMetricFiles(runtimeId) {
  try {
    const result = await runPodman(['inspect', '--format', '{{.State.CgroupPath}}', runtimeId], 10_000, 16 * 1024);
    const rawPath = result.stdout.trim();
    if (!rawPath || rawPath.includes(String.fromCharCode(0))) return null;
    const root = '/sys/fs/cgroup';
    const relative = rawPath.startsWith(root + '/') ? path.relative(root, rawPath) : rawPath.replace(/^[/]+/, '');
    if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) return null;
    const directory = path.resolve(root, relative);
    const fromRoot = path.relative(root, directory);
    if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) return null;
    const names = ['cpu.stat', 'cpu.max', 'memory.current', 'memory.max', 'pids.current', 'pids.max'];
    const values = await Promise.all(names.map(async (name) => {
      try {
        const value = await fs.readFile(path.join(directory, name), 'utf8');
        return value.length <= 16 * 1024 ? value.trim() : null;
      } catch { return null; }
    }));
    if (!values.some((value) => value !== null)) return null;
    return Object.fromEntries(names.map((name, index) => [name, values[index]]));
  } catch {
    return null;
  }
}

async function dashboardInventory() {
  const [records, containers] = await Promise.all([readWorkloadRecords({ ensureDirectory: false }), listManagedContainers({ includeMetrics: true })]);
  const containerByWorkload = new Map(containers.filter((item) => item.workloadId).map((item) => [item.workloadId, item]));
  const taskRecords = records.filter((record) => record.workloadType === 'task' && record.status !== 'removed');
  const recordIds = new Set(taskRecords.map((record) => record.id));
  const workloads = await Promise.all(taskRecords
    .map(async (record) => {
      const container = containerByWorkload.get(record.id);
      const runtimeState = container?.state ?? (record.status === 'removed' ? 'removed' : 'unknown');
      const runtimeId = container?.containerId ?? null;
      let cgroup = null;
      let metricsStatus = 'unavailable';
      let runtimeStartedAt = null;
      let networkRxBytes = null;
      let networkTxBytes = null;
      let networkStatus = 'unavailable';
      if (runtimeState === 'running' && runtimeId) {
        try {
          const identityMatches = await verifyRuntimeContainerIdentity(record, runtimeId);
          if (identityMatches) {
            cgroup = await readCgroupMetricFiles(runtimeId);
            metricsStatus = cgroup ? 'available' : 'unavailable';
            runtimeStartedAt = container?.startedAt ?? null;
            networkRxBytes = container?.network?.rxBytes ?? null;
            networkTxBytes = container?.network?.txBytes ?? null;
            networkStatus = container?.network ? 'available' : 'unavailable';
          }
        } catch {
          metricsStatus = 'unavailable';
        }
      }
      return {
        id: record.id,
        repositoryId: record.repositoryId,
        worktreeId: record.worktreeId ?? null,
        imageDigest: record.imageDigest,
        resources: record.resources,
        networkPolicy: record.networkPolicy ?? null,
        retained: record.retained === true,
        lifecycleStatus: record.status,
        runtimeState,
        runtimeId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        runtimeCreatedAt: container?.createdAt ?? null,
        runtimeStartedAt,
        networkRxBytes,
        networkTxBytes,
        networkStatus,
        cgroup,
        metricsStatus,
      };
    }));
  const unmatchedContainers = containers
    .filter((container) => container.workloadType === 'task' && (!container.workloadId || !recordIds.has(container.workloadId)))
    .map((container) => ({
      containerId: container.containerId,
      runtimeState: container.state,
      createdAt: container.createdAt,
      associationStatus: 'unmatched',
    }));
  return {
    collectedAt: new Date().toISOString(),
    workloads,
    unmatchedContainers,
    sources: {
      workloadRegistry: 'available',
      podmanInventory: 'available',
    },
  };
}

export function projectServiceBootRecoveryAction(record, runtimeState) {
  if (record.workloadType !== 'project-service' || record.status === 'removed') return 'skip';
  if (record.status === 'removing') return 'remove';
  if (record.status === 'stopping') return runtimeState === 'missing' ? 'operator-review' : 'stop';
  if (record.status === 'running' || record.status === 'starting') return runtimeState === 'missing' ? 'operator-review' : 'start';
  if (record.status === 'creating') return runtimeState === 'missing' ? 'operator-review' : 'reconcile-create';
  if (record.status === 'created' || record.status === 'stopped') return runtimeState === 'missing' ? 'operator-review' : runtimeState === 'running' ? 'stop' : record.status === 'created' && runtimeState === 'exited' ? 'reconcile-create' : 'skip';
  return 'operator-review';
}

async function recoverProjectServiceWorkloads() {
  const records = (await readWorkloadRecords()).filter((record) => record.workloadType === 'project-service' && record.status !== 'removed');
  const results = [];
  for (const candidate of records) {
    try {
      await withDurableLocks(LOCK_ROOT, [`repository:${candidate.repositoryId}`, `workload:${candidate.id}`], async () => {
      const record = await readRecord(candidate.id);
      if (record.workloadType !== 'project-service' || record.status === 'removed') return;
      const runtimeId = await resolveRuntimeId(record);
      const runtimeState = runtimeId ? await inspectContainerState(runtimeId) : 'missing';
      const action = projectServiceBootRecoveryAction(record, runtimeState);
      if (action === 'skip') { results.push({ workloadId: record.id, action, status: record.status }); return; }
      if (action === 'operator-review') {
        const updated = { ...record, status: 'unknown', updatedAt: new Date().toISOString() };
        await writeRecord(updated);
        await appendAudit('project-service.boot-recovery-review-required', { workloadId: record.id, repositoryId: record.repositoryId, previousStatus: record.status });
        results.push({ workloadId: record.id, action, status: 'unknown' });
        return;
      }
      if (action === 'reconcile-create') {
        await verifyProjectServiceRestartPolicy(record, runtimeId);
        await verifyProjectServicePod(record, runtimeId);
        const status = runtimeState === 'running' ? 'running' : runtimeState === 'created' ? 'created' : runtimeState === 'exited' ? 'stopped' : 'unknown';
        const updated = { ...record, runtimeId, status, updatedAt: new Date().toISOString() };
        await writeRecord(updated);
        results.push({ workloadId: record.id, action, status });
        return;
      }
      if (action === 'stop') {
        const stopped = await mutate({ operation: 'container.stop', workloadId: record.id, expectedWorkloadType: 'project-service' }, (current) => runPodman(['pod', 'stop', '--time', '10', current.podName], 30_000));
        results.push({ workloadId: record.id, action, status: stopped.workload.status });
        return;
      }
      if (action === 'remove') {
        const removed = await removeProjectServiceWorkload({ workloadId: record.id, repositoryId: record.repositoryId, releaseId: record.releaseId });
        results.push({ workloadId: record.id, action, status: removed.workload?.status ?? 'removed' });
        return;
      }
      if (action === 'start') {
        await startProjectServiceWorkload(record.id);
        results.push({ workloadId: record.id, action, status: 'running' });
      }
      });
    } catch (error) {
      results.push({ workloadId: candidate.id, action: 'error', error: safeError(error) });
      await appendAudit('project-service.boot-recovery.failed', { workloadId: candidate.id, repositoryId: candidate.repositoryId, error: safeError(error) });
    }
  }
  const summary = { scanned: records.length, recovered: results.filter((item) => ['start', 'stop', 'remove', 'reconcile-create'].includes(item.action)).length, operatorReview: results.filter((item) => ['operator-review', 'error'].includes(item.action)).length, results };
  await appendAudit('project-service.boot-recovery.completed', { scanned: summary.scanned, recovered: summary.recovered, operatorReview: summary.operatorReview });
  return summary;
}

async function execute(request) {
  if (request.operation === 'dashboard.inventory') return dashboardInventory();
  await ensureDataDir();
  if (request.operation === 'resource.inspect') return resourceStatus();
  if (request.operation === 'sandbox.retention.set') return setTaskSandboxRetention(request);
  if (request.operation === 'resource.reserve') return reserveProjectResources(request);
  if (request.operation === 'resource.release') return releaseProjectResources(request.repositoryId);
  if (request.operation === 'cleanup.preview') return cleanupPlan();
  if (request.operation === 'cleanup.run') return runCleanup({ dryRun: request.dryRun !== false, confirm: request.confirm === true });
  if (request.operation === 'cleanup.pause') return setMaintenancePause(request.paused);
  if (request.operation === 'workspace.write.begin') return beginWorkspaceWrite(request);
  if (request.operation === 'workspace.write.finish') return finishWorkspaceWrite(request.leaseId);
  if (request.operation === 'audit.list') return { entries: await readAudit(request.limit ?? 100) };
  if (request.operation === 'sandbox.execution.start') return startSandboxExecution(request);
  if (request.operation === 'sandbox.execution.list') return listSandboxExecutions(request.sandboxId);
  if (request.operation === 'sandbox.execution.status') return getSandboxExecutionStatus(request.sandboxId, request.executionId);
  if (request.operation === 'sandbox.execution.logs') return getSandboxExecutionLogs(request.sandboxId, request.executionId, request.offset, request.maxBytes);
  if (request.operation === 'sandbox.execution.cancel') return cancelSandboxExecution(request.sandboxId, request.executionId);
  if (request.operation === 'sandbox.exec') return sandboxExecute(request);
  if (request.operation.startsWith('sandbox.fs.')) return sandboxFilesystem(request);
  if (request.operation === 'image.inspect' || request.operation === 'image.pull') return imageOperation(request);
  if (request.operation === 'container.create') return createWorkload(request);
  if (request.operation === 'project-service.recover') return recoverProjectServiceWorkloads();
  if (request.operation === 'project-service.create') return createProjectServiceWorkload(request);
  if (request.operation === 'project-service.inspect') return inspectProjectServiceWorkload(request.workloadId);
  if (request.operation === 'project-service.start') return startProjectServiceWorkload(request.workloadId);
  if (request.operation === 'project-service.stop') return mutate({ operation: 'container.stop', workloadId: request.workloadId, expectedWorkloadType: 'project-service' }, (record) => runPodman(['pod', 'stop', '--time', '10', record.podName], 30_000));
  if (request.operation === 'project-service.remove') return removeProjectServiceWorkload(request);
  if (request.operation === 'container.list') {
    const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
    const records = [];
    for (const entry of entries) if (entry.isDirectory() && UUID.test(entry.name)) {
      try {
        const record = await readRecord(entry.name);
        if (record.status !== 'removed') {
          const runtimeId = await resolveRuntimeId(record);
          if (runtimeId) {
            const state = await inspectContainerState(runtimeId);
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
      await releaseWorkspaceMount(record);
      const removed = { ...record, status: 'removed', updatedAt: new Date().toISOString() };
      await writeRecord(removed);
      await appendAudit('sandbox.removed', { sandboxId: id, workloadType: removed.workloadType, repositoryId: removed.repositoryId });
      return { workload: removed, removed: true };
    }
    if (record.workloadType === 'task') await cancelActiveSandboxExecutions(record.id, 'sandbox_removed');
    await writeRecord({ ...record, runtimeId, status: 'removing', updatedAt: new Date().toISOString() });
    const exists = await runPodman(['inspect', '--format', '{{.Id}}', runtimeId]).then(() => true).catch(() => false);
    if (!exists) {
      if (record.workloadType === 'task') await markActiveExecutionsInterrupted(record.id, 'sandbox_removed');
      await releaseWorkspaceMount(record);
      const missing = { ...record, status: 'removed', runtimeId: null, updatedAt: new Date().toISOString() };
      await writeRecord(missing);
      return { workload: missing, removed: true };
    }
    const result = await runPodman(['rm', '--force', runtimeId], 30_000);
    await releaseWorkspaceMount(record);
    if (record.workloadType === 'task') await markActiveExecutionsInterrupted(record.id, 'sandbox_removed');
    const updated = { ...record, status: 'removed', updatedAt: new Date().toISOString(), runtimeId: null };
    await writeRecord(updated);
    await appendAudit('sandbox.removed', { sandboxId: id, workloadType: updated.workloadType, repositoryId: updated.repositoryId });
    return { workload: updated, output: result.stdout.trim() };
  }
  if (request.operation === 'container.exec') {
    const record = await readRecord(id);
    assertTaskSandboxWorkload(record);
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
    assertTaskSandboxWorkload(record);
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
export function durableLockKeys(request) {
  if (request.operation === 'container.create') return ['resource:global', `repository:${request.repositoryId}`, ...(request.worktreeId ? [`worktree:${request.worktreeId}`] : [])];
  if (request.operation === 'project-service.create') return ['resource:global', `repository:${request.repositoryId}`, `workload:${request.workloadId}`];
  if (request.operation === 'project-service.recover') return ['resource:global'];
  if (request.operation === 'project-service.start') return ['resource:global', `workload:${request.workloadId}`];
  if (request.operation === 'project-service.stop') return [`workload:${request.workloadId}`];
  if (request.operation === 'project-service.remove') return ['resource:global', `repository:${request.repositoryId}`, `workload:${request.workloadId}`];
  if (request.operation === 'resource.reserve' || request.operation === 'resource.release') return ['resource:global', `repository:${request.repositoryId}`];
  if (request.operation === 'cleanup.run') return ['cleanup:global'];
  if (request.operation === 'container.exec') return [`workload:${request.workloadId}`];
  if (request.operation === 'cleanup.pause') return ['maintenance:global'];
  if (request.operation === 'workspace.write.begin') return ['maintenance:global', `worktree:${request.worktreeId}`];
  if (request.operation === 'sandbox.exec' || request.operation === 'sandbox.fs.write') return [`workload:${request.sandboxId}`];
  if (request.operation === 'sandbox.execution.start') return ['execution-start:global', `workload:${request.sandboxId}`];
  if (request.operation === 'sandbox.execution.cancel' || request.operation === 'sandbox.retention.set') return [`workload:${request.sandboxId}`];
  if (request.operation === 'container.start' || ['container.stop', 'container.remove', 'project-service.start', 'project-service.stop', 'project-service.remove'].includes(request.operation)) return ['workload:' + request.workloadId];
  return [];
}

export function isNewWorkOperation(request) {
  return ['container.create', 'container.start', 'container.exec', 'sandbox.exec', 'sandbox.fs.write', 'sandbox.execution.start', 'workspace.write.begin', 'project-service.create', 'project-service.start'].includes(request.operation);
}

async function executeWithLocks(request) {
  const keys = durableLockKeys(request);
  if (isNewWorkOperation(request) && !keys.includes('maintenance:global')) keys.push('maintenance:global');
  const run = async () => {
    if (isNewWorkOperation(request)) await assertWorkloadsNotPaused(request.operation);
    return execute(request);
  };
  return keys.length ? withDurableLocks(LOCK_ROOT, keys, run) : run();
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
    let requestForAudit;
    try {
      requestForAudit = parseRuntimeRequest(input.slice(0, newline));
      const request = requestForAudit;
      if (request.operation === 'workspace.write.finish') {
        respond(socket, { result: await execute(request) });
        return;
      }
      const sandboxId = request.sandboxId ?? (request.expectedWorkloadType === 'task' ? request.workloadId : null);
      const sandboxOperation = request.operation.startsWith('sandbox.') || sandboxId !== null;
      if (sandboxOperation) {
        const sandboxMutation = ['sandbox.exec', 'sandbox.fs.write', 'sandbox.execution.start', 'sandbox.execution.cancel', 'sandbox.retention.set'].includes(request.operation) ||
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
        try { respond(socket, { result: await executeWithLocks(request) }); }
        finally {
          activeSandboxOperations -= 1;
          const remaining = (activeSandboxWorkloads.get(sandboxId) ?? 1) - 1;
          if (remaining > 0) activeSandboxWorkloads.set(sandboxId, remaining);
          else activeSandboxWorkloads.delete(sandboxId);
          if (sandboxMutation) mutatingWorkloads.delete(sandboxId);
        }
      } else {
        const lifecycleMutation = ['container.start', 'container.stop', 'container.remove', 'project-service.start', 'project-service.stop', 'project-service.remove'].includes(request.operation);
        if (lifecycleMutation) {
          const id = request.workloadId;
          if (mutatingWorkloads.has(id) || isSandboxBusy(activeSandboxWorkloads.get(id) ?? 0)) {
            respond(socket, { error: 'SANDBOX_BUSY: task sandbox operations are active or a lifecycle mutation is already in progress' });
            return;
          }
          mutatingWorkloads.add(id);
        }
        const operation = operationQueue.then(() => executeWithLocks(request));
        operationQueue = operation.then(() => undefined, () => undefined);
        try { respond(socket, { result: await operation }); }
        finally { if (lifecycleMutation) mutatingWorkloads.delete(request.workloadId); }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const errorCode = message.match(/^[A-Z][A-Z0-9_]+(?=:)/)?.[0] ?? 'operation_failed';
      await appendAudit('operation.denied', { operation: requestForAudit?.operation ?? 'invalid', errorCode }).catch(() => {});
      respond(socket, { error: error instanceof Error ? error.message : 'Runtime operation failed' });
    }
  });
  socket.on('error', () => {});
  socket.on('timeout', () => socket.destroy());
}
async function recoverWorkspaceMounts() {
  const records = await readWorkloadRecords();
  for (const record of workspaceMountRecoveryCandidates(records)) {
    const runtimeId = await resolveRuntimeId(record);
    if (runtimeId) continue;
    await releaseWorkspaceMount(record);
    if (record.status === 'creating') {
      await writeRecord({ ...record, status: 'error', runtimeId: null, error: 'Creation was interrupted before a managed container could be confirmed', updatedAt: new Date().toISOString() });
    }
  }
}

async function main() {
  if (process.getuid() === 0) { console.error('Runtime agent must never run as root.'); process.exit(77); }
  if (process.env.USER !== 'vps-sandbox') { console.error('Runtime agent must run as vps-sandbox.'); process.exit(77); }
  if (process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '1') {
    console.error('Runtime agent must be started by its systemd socket unit.'); process.exit(77);
  }

  try {
    await recoverSandboxOperations();
    await recoverWorkspaceMounts();
  } catch (error) {
    console.error(`Sandbox operation recovery failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exit(1);
    return;
  }

  const server = net.createServer(handleConnection);
  server.on('error', (error) => { console.error(error.message); process.exit(1); });
  server.listen({ fd: 3 });
  const reaper = setInterval(() => { void reapExpiredSandboxes(); }, 5 * 60 * 1000);
  reaper.unref();
  void reapExpiredSandboxes();
}
if (import.meta.url === `file://${process.argv[1]}`) void main();

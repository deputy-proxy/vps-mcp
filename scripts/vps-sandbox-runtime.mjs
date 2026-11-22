#!/usr/bin/node
import { execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SOCKET = '/run/vps-sandbox-runtime.sock';
const DATA_DIR = '/var/lib/vps-sandbox/workloads';
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_DIGEST = /^[a-z0-9][a-z0-9._/:+-]{0,180}@sha256:[a-f0-9]{64}$/i;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9._-]{1,199}$/i;
const OPERATIONS = new Set(['image.inspect', 'image.pull', 'container.create', 'container.start', 'container.inspect', 'container.list', 'container.stop', 'container.remove', 'container.exec', 'container.logs', 'sandbox.exec', 'sandbox.fs.list', 'sandbox.fs.read', 'sandbox.fs.write']);
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
    } else {
      validateWorkspaceRelativePath(request.path, request.operation === 'sandbox.fs.list');
      if (request.operation === 'sandbox.fs.write') assert(typeof request.content === 'string' && Buffer.byteLength(request.content, 'utf8') <= 1024 * 1024, 'File content exceeds the 1 MiB write limit');
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
export function buildContainerCreateArgs({ id, workloadType, repositoryId, worktreeId, image, resources, workspaceMount, command }) {
  return [
    'create', '--pull=never', '--cgroup-parent', CGROUP_PARENT, '--name', `vps-wl-${id}`,
    ...labels(id, workloadType, repositoryId, worktreeId),
    '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit', String(resources.pids),
    '--memory', `${resources.memoryMiB}m`, '--cpus', String(resources.cpuMilli / 1000),
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
    ...(workspaceMount ? ['--mount', `type=bind,src=${workspaceMount.path},dst=/workspace,${workspaceMount.access === 'read-only' ? 'ro' : 'rw'}`] : []),
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
      JSON.stringify(existing.resources) === JSON.stringify(resources) &&
      existing.commandFingerprint === fingerprint,
      'Workload ID is already registered with different immutable attributes',
    );
    return { ...existing, reused: true };
  }

  const record = {
    id, workloadType, repositoryId, ...(worktreeId ? { worktreeId } : {}),
    image, imageDigest: image.slice(image.lastIndexOf('@') + 1),
    runtimeId: null, workspaceMount, resources, network: 'none', commandFingerprint: fingerprint,
    status: 'creating', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await writeRecord(record);
  try {
    const args = buildContainerCreateArgs({
      id, workloadType, repositoryId, worktreeId, image, resources, workspaceMount, command: request.command,
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
    const status = current === 'missing' ? 'unknown' : current === 'created' ? 'created' : 'stopped';
    const stopped = { ...recovered, status, updatedAt: new Date().toISOString() };
    await writeRecord(stopped);
    return { workload: stopped, output: '' };
  }
  assert(current !== 'missing', 'Managed runtime container no longer exists; inspect and reconcile before mutation');
  const intentStatus = request.operation === 'container.start' ? 'starting' : 'stopping';
  await writeRecord({ ...recovered, status: intentStatus, updatedAt: new Date().toISOString() });
  const result = await action(recovered);
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
  if (request.operation === 'sandbox.fs.write') assertTaskWorkspaceWritable(record);
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

async function execute(request) {
  await ensureDataDir();
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
      const removed = { ...record, status: 'removed', updatedAt: new Date().toISOString() };
      await writeRecord(removed);
      return { workload: removed, removed: true };
    }
    await writeRecord({ ...record, runtimeId, status: 'removing', updatedAt: new Date().toISOString() });
    const exists = await runPodman(['inspect', '--format', '{{.Id}}', runtimeId]).then(() => true).catch(() => false);
    if (!exists) {
      const missing = { ...record, status: 'removed', runtimeId: null, updatedAt: new Date().toISOString() };
      await writeRecord(missing);
      return { workload: missing, removed: true };
    }
    const result = await runPodman(['rm', '--force', runtimeId], 30_000);
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
      if (request.operation.startsWith('sandbox.')) {
        if (mutatingWorkloads.has(request.sandboxId)) {
          respond(socket, { error: 'SANDBOX_BUSY: lifecycle mutation is in progress' });
          return;
        }
        if (!hasSandboxCapacity(activeSandboxOperations)) {
          respond(socket, { error: 'SANDBOX_CAPACITY_EXCEEDED: maximum concurrent sandbox operations reached' });
          return;
        }
        activeSandboxOperations += 1;
        activeSandboxWorkloads.set(request.sandboxId, (activeSandboxWorkloads.get(request.sandboxId) ?? 0) + 1);
        try { respond(socket, { result: await execute(request) }); }
        finally {
          activeSandboxOperations -= 1;
          const remaining = (activeSandboxWorkloads.get(request.sandboxId) ?? 1) - 1;
          if (remaining > 0) activeSandboxWorkloads.set(request.sandboxId, remaining);
          else activeSandboxWorkloads.delete(request.sandboxId);
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

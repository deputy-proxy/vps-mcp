import net from 'node:net';

export type WorkloadType = 'task' | 'project-service';
export type RuntimeResources = { cpuMilli?: number; memoryMiB?: number; pids?: number };
export type SandboxRuntimeRequest =
  | { operation: 'image.inspect' | 'image.pull'; image: string }
  | {
      operation: 'container.create';
      workloadId: string;
      workloadType: WorkloadType;
      repositoryId: string;
      worktreeId?: string;
      image: string;
      resources?: RuntimeResources;
      network?: 'none';
      readOnlyRootfs?: true;
      workspacePath?: string;
      workspaceAccess?: 'read-only' | 'read-write';
      command?: string[];
    }
  | { operation: 'container.inspect' | 'container.logs'; workloadId: string }
  | { operation: 'container.start' | 'container.stop' | 'container.remove'; workloadId: string; expectedWorkloadType: WorkloadType }
  | { operation: 'container.list' }
  | { operation: 'container.exec'; workloadId: string; command: string[]; timeoutMs?: number };

const SOCKET_PATH = process.env.VPS_SANDBOX_RUNTIME_SOCKET ?? '/run/vps-sandbox-runtime.sock';
const MAX_RESPONSE_BYTES = 1_048_576;
const TIMEOUT_MS = 150_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_DIGEST = /^[a-z0-9][a-z0-9._/:+-]{0,180}@sha256:[a-f0-9]{64}$/i;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9._-]{1,199}$/i;

export function validateSandboxRuntimeRequest(request: SandboxRuntimeRequest): void {
  if (request.operation === 'image.inspect' || request.operation === 'image.pull') {
    if (!IMAGE_DIGEST.test(request.image)) throw new Error('Image must be pinned by sha256 digest');
    return;
  }
  if (request.operation === 'container.list') return;
  if (!('workloadId' in request)) throw new Error('Workload ID is required');
  if (!UUID.test(request.workloadId)) throw new Error('Invalid workload ID');
  if (request.operation === 'container.create') {
    if (request.workloadType !== 'task' && request.workloadType !== 'project-service') throw new Error('Invalid workload type');
    if (!REPOSITORY_ID.test(request.repositoryId)) throw new Error('Invalid repository ID');
    if (!IMAGE_DIGEST.test(request.image)) throw new Error('Image must be pinned by sha256 digest');
    if (request.worktreeId && !UUID.test(request.worktreeId)) throw new Error('Invalid worktree ID');
    if (request.command) validateArgv(request.command);
    if (request.workspacePath !== undefined && (!request.workspacePath.startsWith('/') || request.workspacePath.includes('\0'))) throw new Error('Workspace path must be an absolute path');
    if (request.workspaceAccess !== undefined && request.workspaceAccess !== 'read-only' && request.workspaceAccess !== 'read-write') throw new Error('Invalid workspace access mode');
    if (request.network !== undefined && request.network !== 'none') throw new Error('Only network=none is supported');
    if (request.readOnlyRootfs !== undefined && request.readOnlyRootfs !== true) throw new Error('Read-only root filesystem is mandatory');
    validateResources(request.resources);
    return;
  }
  if (request.operation === 'container.start' || request.operation === 'container.stop' || request.operation === 'container.remove') {
    if (request.expectedWorkloadType !== 'task' && request.expectedWorkloadType !== 'project-service') throw new Error('Expected workload type is required');
  }
  if (request.operation === 'container.exec') {
    validateArgv(request.command);
    if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > 120_000)) {
      throw new Error('timeoutMs must be between 1000 and 120000');
    }
  }
}

function validateArgv(argv: string[]): void {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64 || argv.some((arg) => typeof arg !== 'string' || !arg.length || arg.length > 4096 || arg.includes('\0'))) {
    throw new Error('Command must be a non-empty argument array of bounded strings');
  }
}
function validateResources(resources?: RuntimeResources): void {
  if (!resources) return;
  const { cpuMilli = 1000, memoryMiB = 1024, pids = 128 } = resources;
  if (!Number.isInteger(cpuMilli) || cpuMilli < 100 || cpuMilli > 2000) throw new Error('cpuMilli must be between 100 and 2000');
  if (!Number.isInteger(memoryMiB) || memoryMiB < 128 || memoryMiB > 4096) throw new Error('memoryMiB must be between 128 and 4096');
  if (!Number.isInteger(pids) || pids < 32 || pids > 512) throw new Error('pids must be between 32 and 512');
}

export async function requestSandboxRuntime<T = Record<string, unknown>>(
  request: SandboxRuntimeRequest,
  socketPath = SOCKET_PATH,
): Promise<T> {
  validateSandboxRuntimeRequest(request);
  return await new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (Buffer.byteLength(response, 'utf8') > MAX_RESPONSE_BYTES) finish(new Error('Runtime response exceeded the allowed size'));
    });
    socket.on('end', () => {
      try {
        const payload = JSON.parse(response.trim()) as { result?: T; error?: string };
        if (typeof payload.error === 'string') finish(new Error(payload.error));
        else if (!Object.hasOwn(payload, 'result')) finish(new Error('Runtime returned an invalid response'));
        else finish(undefined, payload.result);
      } catch {
        finish(new Error('Runtime returned invalid JSON'));
      }
    });
    socket.on('timeout', () => finish(new Error('Runtime operation timed out')));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') finish(new Error(`Sandbox runtime is not installed or active at ${socketPath}`));
      else if (error.code === 'EACCES') finish(new Error(`MCP cannot access ${socketPath}; verify socket group and mode`));
      else finish(error);
    });
  });
}


export type RuntimeWorkloadStatus = 'creating' | 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'removing' | 'removed' | 'unknown' | 'error';
export type RuntimeWorkloadRecord = {
  id: string;
  workloadType: WorkloadType;
  repositoryId: string;
  worktreeId?: string;
  image: string;
  imageDigest: string;
  runtimeId: string | null;
  workspaceMount: { path: string; access: 'read-only' | 'read-write'; destination: '/workspace' } | null;
  resources: { cpuMilli: number; memoryMiB: number; pids: number };
  network: 'none';
  status: RuntimeWorkloadStatus;
  createdAt: string;
  updatedAt: string;
};
export interface SandboxRuntimeAdapter {
  inspectImage(image: string): Promise<{ image: string; imageId: string }>;
  pullImage(image: string): Promise<{ image: string; pulled: true; output: string }>;
  createWorkload(input: Extract<SandboxRuntimeRequest, { operation: 'container.create' }>): Promise<RuntimeWorkloadRecord>;
  startWorkload(id: string, expectedType: WorkloadType): Promise<unknown>;
  inspectWorkload(id: string): Promise<unknown>;
  listWorkloads(): Promise<{ workloads: RuntimeWorkloadRecord[] }>;
  stopWorkload(id: string, expectedType: WorkloadType): Promise<unknown>;
  removeWorkload(id: string, expectedType: WorkloadType): Promise<unknown>;
  executeInWorkload(id: string, command: string[], timeoutMs?: number): Promise<{ workloadId: string; exitCode: number; stdout: string; stderr: string }>;
  readWorkloadLogs(id: string): Promise<{ workloadId: string; logs: string }>;
}
export function createSandboxRuntimeAdapter(socketPath = SOCKET_PATH): SandboxRuntimeAdapter {
  return {
    inspectImage: (image) => requestSandboxRuntime({ operation: 'image.inspect', image }, socketPath),
    pullImage: (image) => requestSandboxRuntime({ operation: 'image.pull', image }, socketPath),
    createWorkload: (input) => requestSandboxRuntime(input, socketPath),
    startWorkload: (workloadId, expectedWorkloadType) => requestSandboxRuntime({ operation: 'container.start', workloadId, expectedWorkloadType }, socketPath),
    inspectWorkload: (workloadId) => requestSandboxRuntime({ operation: 'container.inspect', workloadId }, socketPath),
    listWorkloads: () => requestSandboxRuntime({ operation: 'container.list' }, socketPath),
    stopWorkload: (workloadId, expectedWorkloadType) => requestSandboxRuntime({ operation: 'container.stop', workloadId, expectedWorkloadType }, socketPath),
    removeWorkload: (workloadId, expectedWorkloadType) => requestSandboxRuntime({ operation: 'container.remove', workloadId, expectedWorkloadType }, socketPath),
    executeInWorkload: (workloadId, command, timeoutMs) => requestSandboxRuntime({ operation: 'container.exec', workloadId, command, ...(timeoutMs ? { timeoutMs } : {}) }, socketPath),
    readWorkloadLogs: (workloadId) => requestSandboxRuntime({ operation: 'container.logs', workloadId }, socketPath),
  };
}

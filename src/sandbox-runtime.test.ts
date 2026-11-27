import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSandboxRuntimeAdapter, formatSandboxRuntimeError, requestSandboxRuntime, validateSandboxRuntimeRequest } from './sandbox-runtime.js';

vi.mock('./task-workspaces.js', () => ({
  prepareTaskWorkspaceForRuntime: vi.fn(async (id: string) => ({
    id,
    repositoryId: 'deputy-proxy-vps-mcp-01d9433d21',
    worktreeId: id,
    workspacePath: '/var/lib/vps-mcp/task-workspaces/worktrees/deputy-proxy-vps-mcp-01d9433d21/' + id,
  })),
}));

const id = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
const image = `docker.io/library/node@sha256:${'a'.repeat(64)}`;

describe('sandbox runtime request contract', () => {
  it('returns structured sandbox errors and redacts credential-like output', () => {
    expect(formatSandboxRuntimeError(new Error('SANDBOX_CAPACITY_EXCEEDED: busy'))).toEqual({
      ok: false,
      error: { code: 'SANDBOX_CAPACITY_EXCEEDED', message: 'SANDBOX_CAPACITY_EXCEEDED: busy' },
    });
    expect(formatSandboxRuntimeError(new Error('Symbolic links are not permitted for ghp_' + 'a'.repeat(30)))).toMatchObject({
      ok: false,
      error: { code: 'SANDBOX_PATH_REJECTED', message: 'Symbolic links are not permitted for [REDACTED_TOKEN]' },
    });
  });

  it('accepts only digest-pinned images and bounded workload metadata', () => {
    expect(() => validateSandboxRuntimeRequest({ operation: 'image.inspect', image })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({
      operation: 'container.create', workloadId: id, workloadType: 'task',
      repositoryId: 'deputy-proxy-vps-mcp', worktreeId: id, workspacePath: '/var/lib/vps-mcp/task-workspaces/worktrees/deputy-proxy-vps-mcp/' + id, image, resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
      network: 'none', readOnlyRootfs: true, command: ['sleep', 'infinity'],
    })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({
      operation: 'container.create', workloadId: id, workloadType: 'task', repositoryId: 'repo', worktreeId: id, image,
    })).toThrow('authorized managed worktree');
    expect(() => validateSandboxRuntimeRequest({
      operation: 'container.create', workloadId: id, workloadType: 'project-service' as 'task', repositoryId: 'repo', image, network: 'none', readOnlyRootfs: true,
    })).toThrow('reserved for task workloads');
    expect(() => validateSandboxRuntimeRequest({
      operation: 'project-service.create', workloadId: id, repositoryId: 'repo', releaseId: id, image,
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, diskMiB: 4096 }, reservationResources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 }, restartPolicy: 'unless-stopped',
    })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({
      operation: 'project-service.create', workloadId: id, repositoryId: 'repo', releaseId: id, image,
      resources: { cpuMilli: 1500, memoryMiB: 512, pids: 64, diskMiB: 4096 },
      reservationResources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 }, restartPolicy: 'unless-stopped',
    })).toThrow('exceed the aggregate project reservation');
    expect(() => validateSandboxRuntimeRequest({
      operation: 'project-service.create', workloadId: id, repositoryId: 'repo', releaseId: id, image: 'alpine:latest',
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, diskMiB: 4096 }, reservationResources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 }, restartPolicy: 'unless-stopped',
    })).toThrow('sha256');
  });

  it('rejects mutable image tags, invalid IDs, raw flags and unsafe resource values', () => {
    expect(() => validateSandboxRuntimeRequest({ operation: 'image.pull', image: 'alpine:latest' })).toThrow('sha256');
    expect(() => validateSandboxRuntimeRequest({ operation: 'container.inspect', workloadId: '../../etc/passwd' })).toThrow('workload ID');
    expect(() => validateSandboxRuntimeRequest({
      operation: 'container.create', workloadId: id, workloadType: 'task', repositoryId: 'repo', worktreeId: id, workspacePath: '/var/lib/vps-mcp/task-workspaces/worktrees/repo/' + id,
      image, resources: { memoryMiB: 8192 },
    })).toThrow('memoryMiB');
    expect(() => validateSandboxRuntimeRequest({
      operation: 'container.exec', workloadId: id, command: ['sh', '-c', 'id; rm -rf /'],
    })).not.toThrow();
  });

  it('validates global runtime operations without requiring a workload ID', () => {
    expect(() => validateSandboxRuntimeRequest({ operation: 'cleanup.pause', paused: true })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'cleanup.pause', paused: false })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'audit.list', limit: 20 })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'audit.list' })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'resource.inspect' })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'cleanup.preview' })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'cleanup.run', dryRun: true })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'resource.reserve', repositoryId: 'repo-123', resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, diskMiB: 4096 } })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'resource.release', repositoryId: 'repo-123' })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'cleanup.pause', paused: 'yes' as unknown as boolean })).toThrow('paused');
    expect(() => validateSandboxRuntimeRequest({ operation: 'audit.list', limit: 501 })).toThrow('limit');
    expect(() => validateSandboxRuntimeRequest({ operation: 'resource.reserve', repositoryId: 'repo-123', resources: { memoryMiB: 8192 } })).toThrow('memoryMiB');
  });

  it('validates managed workspace write leases', () => {
    expect(() => validateSandboxRuntimeRequest({ operation: 'workspace.write.begin', repositoryId: 'repo-123', worktreeId: id })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'workspace.write.begin', repositoryId: '../repo', worktreeId: id })).toThrow('repository ID');
    expect(() => validateSandboxRuntimeRequest({ operation: 'workspace.write.begin', repositoryId: 'repo-123', worktreeId: '../worktree' })).toThrow('worktree ID');
    expect(() => validateSandboxRuntimeRequest({ operation: 'workspace.write.finish', leaseId: id })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'workspace.write.finish', leaseId: 'not-a-uuid' })).toThrow('lease ID');
  });

  it('requires a sandbox ID and validates task-only operation arguments', () => {
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.exec', sandboxId: id, command: ['node', '-v'] })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.exec', sandboxId: id, operationId: id, command: ['node', '-v'] })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.exec', sandboxId: id, operationId: 'not-a-uuid', command: ['node', '-v'] })).toThrow('operation ID');
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.execution.start', sandboxId: id, executionId: id, command: ['sleep', '1'] })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.fs.list', sandboxId: id, path: '' })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.fs.read', sandboxId: id, path: 'src/index.ts' })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.fs.write', sandboxId: id, path: 'notes.txt', content: 'hello' })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.exec', sandboxId: '../../host', command: ['id'] })).toThrow('sandbox ID');
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.exec', sandboxId: id, command: ['id'], cwd: '../' })).toThrow('unsafe component');
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.fs.read', sandboxId: id, path: '/etc/passwd' })).toThrow('workspace-relative');
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.fs.write', sandboxId: id, path: '../outside', content: 'x' })).toThrow('unsafe component');
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.exec', sandboxId: id, command: ['id'], env: { PATH: '/tmp' } })).toThrow('Environment');
    expect(() => validateSandboxRuntimeRequest({ operation: 'sandbox.exec', sandboxId: id, command: ['id'], timeoutMs: 999 })).toThrow('timeoutMs');
  });

  it('rejects network access and writable root filesystems', () => {
    expect(() => validateSandboxRuntimeRequest({
      operation: 'container.create', workloadId: id, workloadType: 'task', repositoryId: 'repo', worktreeId: id, workspacePath: '/var/lib/vps-mcp/task-workspaces/worktrees/repo/' + id,
      image, network: 'bridge' as 'none',
    })).toThrow('network=none');
    expect(() => validateSandboxRuntimeRequest({
      operation: 'container.create', workloadId: id, workloadType: 'task', repositoryId: 'repo', worktreeId: id, workspacePath: '/var/lib/vps-mcp/task-workspaces/worktrees/repo/' + id,
      image, readOnlyRootfs: false as true,
    })).toThrow(/read-only/i);
  });
});

describe('sandbox runtime socket client', () => {
  let server: net.Server | undefined;
  let socketPath = '';
  const sockets: net.Socket[] = [];

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
    server?.close();
    server = undefined;
  });

  it('sends a typed request and unwraps a successful response', async () => {
    socketPath = `/tmp/vps-runtime-test-${process.pid}-${Date.now()}.sock`;
    server = net.createServer((socket) => {
      sockets.push(socket);
      let input = '';
      socket.on('data', (chunk) => {
        input += chunk.toString();
        if (input.includes('\n')) {
          const request = JSON.parse(input.trim());
          socket.end(JSON.stringify({ result: { operation: request.operation, status: 'ok' } }) + '\n');
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    await expect(requestSandboxRuntime<{ status: string }>({ operation: 'container.list' }, socketPath)).resolves.toEqual({ operation: 'container.list', status: 'ok' });
  });

  it('uses the dedicated project-service creation operation', async () => {
    socketPath = `/tmp/vps-runtime-create-${process.pid}-${Date.now()}.sock`;
    server = net.createServer((socket) => {
      sockets.push(socket);
      let input = '';
      socket.on('data', (chunk) => {
        input += chunk.toString();
        if (input.includes('\n')) {
          const request = JSON.parse(input.trim());
          socket.end(JSON.stringify({ result: request }) + '\n');
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    const adapter = createSandboxRuntimeAdapter(socketPath);
    const result = await adapter.createProjectServiceWorkload({
      workloadId: id,
      repositoryId: 'deputy-proxy-vps-mcp',
      releaseId: id,
      image,
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, diskMiB: 4096 },
      reservationResources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 },
      restartPolicy: 'unless-stopped',
      command: ['--nodaemonize'],
    });
    expect(result).toMatchObject({ operation: 'project-service.create', workloadId: id, repositoryId: 'deputy-proxy-vps-mcp' });
  });

  it('routes every project-service lifecycle operation through its dedicated broker operation', async () => {
    socketPath = `/tmp/vps-runtime-project-lifecycle-${process.pid}-${Date.now()}.sock`;
    const operations: Array<Record<string, unknown>> = [];
    server = net.createServer((socket) => {
      sockets.push(socket);
      let input = '';
      socket.on('data', (chunk) => {
        input += chunk.toString();
        if (!input.includes('\n')) return;
        const request = JSON.parse(input.trim()) as Record<string, unknown>;
        operations.push(request);
        socket.end(JSON.stringify({ result: { operation: request.operation, workloadId: request.workloadId, status: 'ok' } }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    const adapter = createSandboxRuntimeAdapter(socketPath);
    await adapter.pullImage(image);
    await adapter.createProjectServiceWorkload({ workloadId: id, repositoryId: 'deputy-proxy-vps-mcp', releaseId: id, image, resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, diskMiB: 4096 }, reservationResources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 }, restartPolicy: 'unless-stopped' });
    await adapter.inspectProjectServiceWorkload(id);
    await adapter.startProjectServiceWorkload(id);
    await adapter.stopProjectServiceWorkload(id);
    await adapter.removeProjectServiceWorkload({ workloadId: id, repositoryId: 'deputy-proxy-vps-mcp', releaseId: id });
    await adapter.reserveProjectResources({ repositoryId: 'deputy-proxy-vps-mcp', resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, diskMiB: 4096 } });
    await adapter.releaseProjectResources('deputy-proxy-vps-mcp');
    expect(operations).toEqual([
      { operation: 'image.pull', image },
      { operation: 'project-service.create', workloadId: id, repositoryId: 'deputy-proxy-vps-mcp', releaseId: id, image, resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, diskMiB: 4096 }, reservationResources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 }, restartPolicy: 'unless-stopped' },
      { operation: 'project-service.inspect', workloadId: id },
      { operation: 'project-service.start', workloadId: id },
      { operation: 'project-service.stop', workloadId: id },
      { operation: 'project-service.remove', workloadId: id, repositoryId: 'deputy-proxy-vps-mcp', releaseId: id },
      { operation: 'resource.reserve', repositoryId: 'deputy-proxy-vps-mcp', resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, diskMiB: 4096 } },
      { operation: 'resource.release', repositoryId: 'deputy-proxy-vps-mcp' },
    ]);
  });

  it('surfaces a broker error without pretending the operation succeeded', async () => {
    socketPath = `/tmp/vps-runtime-error-${process.pid}-${Date.now()}.sock`;
    server = net.createServer((socket) => { sockets.push(socket); socket.end(JSON.stringify({ error: 'runtime unavailable' }) + '\n'); });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    await expect(requestSandboxRuntime({ operation: 'container.list' }, socketPath)).rejects.toThrow('runtime unavailable');
  });
});


describe('task sandbox lifecycle adapter', () => {
  const worktreeId = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
  const taskSandboxId = '234e5321-b4d7-4d4f-be92-ce56a984adaa';
  const projectSandboxId = '334e5321-b4d7-4d4f-be92-ce56a984adaa';
  const repositoryId = 'deputy-proxy-vps-mcp-01d9433d21';
  const approvedImage = 'docker.io/library/busybox@sha256:' + 'b'.repeat(64);
  let server: net.Server | undefined;
  let socketPath = '';
  const sockets: net.Socket[] = [];
  const operations: Array<Record<string, unknown>> = [];

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
    server?.close();
    server = undefined;
    operations.length = 0;
  });

  it('creates, lists and controls task workloads without exposing project-service workloads', async () => {
    socketPath = '/tmp/vps-runtime-lifecycle-' + process.pid + '-' + Date.now() + '.sock';
    server = net.createServer((socket) => {
      sockets.push(socket);
      let input = '';
      socket.on('data', (chunk) => {
        input += chunk.toString();
        if (!input.includes('\n')) return;
        const request = JSON.parse(input.trim()) as Record<string, unknown>;
        operations.push(request);
        const id = String(request.workloadId ?? taskSandboxId);
        const record = {
          id,
          workloadType: id === projectSandboxId ? 'project-service' : 'task',
          repositoryId,
          image: approvedImage,
          imageDigest: 'sha256:' + 'b'.repeat(64),
          runtimeId: 'a'.repeat(64),
          workspaceMount: { path: '/var/lib/vps-mcp/task-workspaces/worktrees/' + repositoryId + '/' + worktreeId, access: 'read-write', destination: '/workspace' },
          resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
          network: 'none',
          status: 'created',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
        let result: unknown;
        switch (request.operation) {
          case 'image.inspect': result = { image: approvedImage, imageId: 'sha256:' + 'b'.repeat(64) }; break;
          case 'container.create': result = { ...record, id: request.workloadId }; break;
          case 'container.inspect': result = { workload: { ...record, id } }; break;
          case 'container.list': result = { workloads: [{ ...record, id: taskSandboxId }, { ...record, id: projectSandboxId, workloadType: 'project-service' }] }; break;
          case 'container.logs': result = { workloadId: id, logs: 'sandbox ready' }; break;
          default: result = { operation: request.operation, workloadId: id, ok: true };
        }
        socket.end(JSON.stringify({ result }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));

    const adapter = createSandboxRuntimeAdapter(socketPath);
    const created = await adapter.createTaskSandbox({ repositoryId, worktreeId, image: approvedImage });
    expect(created).toMatchObject({ workloadType: 'task', repositoryId, image: approvedImage, status: 'created' });
    expect(operations.map((item) => item.operation)).toEqual(['image.inspect', 'container.create']);
    expect(operations[1]).toMatchObject({
      workloadType: 'task', repositoryId, worktreeId, network: 'none', readOnlyRootfs: true,
      workspacePath: '/var/lib/vps-mcp/task-workspaces/worktrees/' + repositoryId + '/' + worktreeId,
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
    });
    expect(operations[1]).not.toHaveProperty('imageTag');

    await adapter.startTaskSandbox(taskSandboxId);
    await expect(adapter.inspectTaskSandbox(taskSandboxId)).resolves.toMatchObject({ workload: { workloadType: 'task' } });
    await expect(adapter.listTaskSandboxes()).resolves.toMatchObject({ workloads: [{ id: taskSandboxId, workloadType: 'task' }] });
    await expect(adapter.readTaskSandboxLogs(taskSandboxId)).resolves.toEqual({ workloadId: taskSandboxId, logs: 'sandbox ready' });
    await adapter.stopTaskSandbox(taskSandboxId);
    await adapter.removeTaskSandbox(taskSandboxId);
    await expect(adapter.startTaskSandbox(projectSandboxId)).rejects.toThrow('SANDBOX_TYPE_MISMATCH');
  });
});

import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { requestSandboxRuntime, validateSandboxRuntimeRequest } from './sandbox-runtime.js';

const id = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
const image = `docker.io/library/node@sha256:${'a'.repeat(64)}`;

describe('sandbox runtime request contract', () => {
  it('accepts only digest-pinned images and bounded workload metadata', () => {
    expect(() => validateSandboxRuntimeRequest({ operation: 'image.inspect', image })).not.toThrow();
    expect(() => validateSandboxRuntimeRequest({
      operation: 'container.create', workloadId: id, workloadType: 'task',
      repositoryId: 'deputy-proxy-vps-mcp', worktreeId: id, workspacePath: '/var/lib/vps-mcp/task-workspaces/worktrees/deputy-proxy-vps-mcp/' + id, image, resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
      network: 'none', readOnlyRootfs: true, command: ['sleep', 'infinity'],
    })).not.toThrow();
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

  it('surfaces a broker error without pretending the operation succeeded', async () => {
    socketPath = `/tmp/vps-runtime-error-${process.pid}-${Date.now()}.sock`;
    server = net.createServer((socket) => { sockets.push(socket); socket.end(JSON.stringify({ error: 'runtime unavailable' }) + '\n'); });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    await expect(requestSandboxRuntime({ operation: 'container.list' }, socketPath)).rejects.toThrow('runtime unavailable');
  });
});

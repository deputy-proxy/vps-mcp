import { describe, expect, it } from 'vitest';
import { assertWorkloadTypeMatch, buildContainerCreateArgs, expectedTaskWorkspacePath, parseRuntimeRequest, buildSandboxExecArgs, buildSandboxFilesystemScript, buildSandboxFilesystemArgs, parseSandboxDirectoryListing, decodeSandboxFile, assertTaskWorkspaceWritable, assertTaskSandboxWorkload, boundedSandboxOutput, hasSandboxCapacity, isSandboxBusy, safeImage } from './vps-sandbox-runtime.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('rootless workload runtime request validation', () => {
  it.each([
    { operation: 'image.inspect', image: `docker.io/library/node@sha256:${'a'.repeat(64)}` },
    { operation: 'container.list' },
    { operation: 'container.inspect', workloadId: '134e5321-b4d7-4d4f-be92-ce56a984adaa' },
    {
      operation: 'container.create',
      workloadId: '134e5321-b4d7-4d4f-be92-ce56a984adaa',
      workloadType: 'task',
      repositoryId: 'deputy-proxy-vps-mcp',
      image: `docker.io/library/node@sha256:${'a'.repeat(64)}`,
      network: 'none',
      readOnlyRootfs: true,
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
    },
  ])('accepts the approved request shape %#', (request) => {
    expect(parseRuntimeRequest(JSON.stringify(request))).toEqual(request);
  });

  it('derives task workspace mounts from the registered repository/worktree identity', () => {
    expect(expectedTaskWorkspacePath('/var/lib/vps-mcp/task-workspaces/worktrees', 'deputy-proxy-vps-mcp', '134e5321-b4d7-4d4f-be92-ce56a984adaa'))
      .toBe('/var/lib/vps-mcp/task-workspaces/worktrees/deputy-proxy-vps-mcp/134e5321-b4d7-4d4f-be92-ce56a984adaa');
    expect(() => expectedTaskWorkspacePath('/var/lib/vps-mcp/task-workspaces', 'repo', '134e5321-b4d7-4d4f-be92-ce56a984adaa')).toThrow('not approved');
    expect(() => expectedTaskWorkspacePath('/srv/vps-mcp-workspaces', '../etc', '134e5321-b4d7-4d4f-be92-ce56a984adaa')).toThrow('Invalid repository ID');
  });

  it('requires administrator approval for exact immutable image digests', () => {
    const previous = process.env.VPS_SANDBOX_ALLOWED_IMAGES;
    const approvedImage = 'docker.io/library/node@sha256:' + 'a'.repeat(64);
    process.env.VPS_SANDBOX_ALLOWED_IMAGES = approvedImage;
    expect(safeImage(approvedImage)).toBe(approvedImage);
    expect(() => safeImage('docker.io/library/alpine@sha256:' + 'b'.repeat(64))).toThrow('allowlist');
    if (previous === undefined) delete process.env.VPS_SANDBOX_ALLOWED_IMAGES;
    else process.env.VPS_SANDBOX_ALLOWED_IMAGES = previous;
  });

  it('accepts task sandbox operations with strict request schemas', () => {
    const sandboxId = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.exec', sandboxId, command: ['node', '-v'], cwd: 'src', timeoutMs: 5000, maxOutputBytes: 8192, env: { CI: 'true' } }))).toMatchObject({ operation: 'sandbox.exec', sandboxId });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.list', sandboxId, path: '' }))).toMatchObject({ operation: 'sandbox.fs.list' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.read', sandboxId, path: 'README.md' }))).toMatchObject({ operation: 'sandbox.fs.read' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.write', sandboxId, path: 'notes.txt', content: 'hello' }))).toMatchObject({ operation: 'sandbox.fs.write' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.start', sandboxId, command: ['node', 'build.js'], cwd: 'src', timeoutMs: 60_000 }))).toMatchObject({ operation: 'sandbox.execution.start', sandboxId });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.list', sandboxId }))).toMatchObject({ operation: 'sandbox.execution.list', sandboxId });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.status', sandboxId, executionId: '234e5321-b4d7-4d4f-be92-ce56a984adaa' }))).toMatchObject({ operation: 'sandbox.execution.status' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.logs', sandboxId, executionId: '234e5321-b4d7-4d4f-be92-ce56a984adaa', offset: 128, maxBytes: 8192 }))).toMatchObject({ operation: 'sandbox.execution.logs' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.cancel', sandboxId, executionId: '234e5321-b4d7-4d4f-be92-ce56a984adaa' }))).toMatchObject({ operation: 'sandbox.execution.cancel' });
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.status', sandboxId, executionId: 'not-a-uuid' }))).toThrow('Invalid execution ID');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.start', sandboxId, command: ['id'], timeoutMs: 90_000_000 }))).toThrow('timeoutMs');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.logs', sandboxId, executionId: '234e5321-b4d7-4d4f-be92-ce56a984adaa', maxBytes: 300_000 }))).toThrow('maxBytes');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.exec', sandboxId, command: ['id'], cwd: '../etc' }))).toThrow('unsafe component');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.exec', sandboxId, command: ['id'], env: { PATH: '/tmp' } }))).toThrow('Environment');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.read', sandboxId, path: '/etc/passwd' }))).toThrow('workspace-relative');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.read', sandboxId, path: 'src\\file.txt' }))).toThrow('workspace-relative');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.read', sandboxId, path: 'a'.repeat(4097) }))).toThrow('workspace-relative');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.write', sandboxId, path: 'file', content: 'x'.repeat(1024 * 1024 + 1) }))).toThrow('1 MiB');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.exec', sandboxId, command: ['id'], extra: true }))).toThrow('unsupported properties');
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'resource.inspect' }))).toMatchObject({ operation: 'resource.inspect' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.retention.set', sandboxId, retained: true }))).toMatchObject({ operation: 'sandbox.retention.set', retained: true });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.exec', sandboxId, operationId: sandboxId, command: ['id'] }))).toMatchObject({ operation: 'sandbox.exec', operationId: sandboxId });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.start', sandboxId, executionId: sandboxId, command: ['sleep', '1'] }))).toMatchObject({ operation: 'sandbox.execution.start', executionId: sandboxId });
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.retention.set', sandboxId, retained: 'yes' }))).toThrow('retained must be a boolean');
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'resource.reserve', repositoryId: 'repo-123', resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, diskMiB: 4096 } }))).toMatchObject({ operation: 'resource.reserve' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'cleanup.run', dryRun: true }))).toMatchObject({ operation: 'cleanup.run' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'cleanup.pause', paused: true }))).toMatchObject({ operation: 'cleanup.pause' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'audit.list', limit: 20 }))).toMatchObject({ operation: 'audit.list' });
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'resource.reserve', repositoryId: 'repo-123', resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, admin: true } }))).toThrow('unsupported properties');
    const create = { operation: 'container.create', workloadId: sandboxId, workloadType: 'task', repositoryId: 'repo-123', worktreeId: '234e5321-b4d7-4d4f-be92-ce56a984adaa', image: `docker.io/library/node@sha256:${'a'.repeat(64)}`, network: 'host', readOnlyRootfs: true };
    expect(() => parseRuntimeRequest(JSON.stringify(create))).toThrow('Only network=none');
    expect(parseRuntimeRequest(JSON.stringify({ ...create, workloadType: 'project-service', network: 'none' }))).toMatchObject({ operation: 'container.create', workloadType: 'project-service', network: 'none' });
  });

  it('runs list/read/write operations within the workspace root and rejects escapes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-mcp-sandbox-fs-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-mcp-sandbox-other-'));
    const runScript = (operation, relative, input) => {
      const script = buildSandboxFilesystemScript(operation, root);
      return spawnSync('/bin/sh', ['-c', script, '--', relative], { input, encoding: 'utf8' });
    };
    try {
      await fs.mkdir(path.join(root, 'src'));
      await fs.writeFile(path.join(root, 'src', 'main.ts'), 'before');
      await fs.symlink(outside, path.join(root, 'outside-link'));
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'secret-link'));
      await fs.writeFile(path.join(outside, 'secret.txt'), 'not for this sandbox');

      const listed = runScript('sandbox.fs.list', '', '');
      expect(listed.status).toBe(0);
      const entries = parseSandboxDirectoryListing(listed.stdout);
      expect(entries.map((entry) => entry.name)).toContain('src');
      expect(entries.map((entry) => entry.name)).not.toContain('outside-link');
      expect(entries.map((entry) => entry.name)).not.toContain('secret-link');

      const read = runScript('sandbox.fs.read', 'src/main.ts', '');
      expect(read.status).toBe(0);
      expect(decodeSandboxFile(read.stdout)).toMatchObject({ content: 'before' });
      expect(runScript('sandbox.fs.read', 'secret-link', '').status).not.toBe(0);
      expect(runScript('sandbox.fs.read', 'outside-link/secret.txt', '').status).not.toBe(0);
      expect(runScript('sandbox.fs.list', 'outside-link', '').status).not.toBe(0);
      expect(runScript('sandbox.fs.read', '../' + path.basename(outside) + '/secret.txt', '').status).not.toBe(0);

      const write = runScript('sandbox.fs.write', 'src/main.ts', 'after');
      expect(write.status).toBe(0);
      expect(decodeSandboxFile(runScript('sandbox.fs.read', 'src/main.ts', '').stdout)).toMatchObject({ content: 'after' });
      expect(runScript('sandbox.fs.write', 'secret-link', 'overwrite').status).not.toBe(0);
      expect(runScript('sandbox.fs.write', '../other/secret.txt', 'overwrite').status).not.toBe(0);
      expect(runScript('sandbox.fs.write', 'src/new.txt', 'x'.repeat(1024 * 1024)).status).toBe(0);
      expect((await fs.readFile(path.join(root, 'src', 'new.txt'), 'utf8')).length).toBe(1024 * 1024);

      await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
      const large = runScript('sandbox.fs.read', 'large.txt', '');
      expect(large.status).not.toBe(0);
      await fs.writeFile(path.join(root, 'invalid-utf8.txt'), Buffer.from([0xff, 0xfe]));
      expect(() => decodeSandboxFile(runScript('sandbox.fs.read', 'invalid-utf8.txt', '').stdout)).toThrow('valid UTF-8');
      execFileSync('/usr/bin/mkfifo', [path.join(root, 'pipe')]);
      expect(runScript('sandbox.fs.read', 'pipe', '').status).not.toBe(0);
      expect(parseSandboxDirectoryListing(runScript('sandbox.fs.list', '', '').stdout).map((entry) => entry.name)).not.toContain('pipe');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('enforces read-only workspace mounts and bounds/redacts command output', () => {
    expect(() => assertTaskSandboxWorkload({ workloadType: 'project-service' })).toThrow('only for task workloads');
    expect(() => assertTaskSandboxWorkload({ workloadType: 'task' })).not.toThrow();
    expect(() => assertTaskWorkspaceWritable({ workloadType: 'task', workspaceMount: { access: 'read-only' } })).toThrow('read-only');
    expect(() => assertTaskWorkspaceWritable({ workloadType: 'task', workspaceMount: { access: 'read-write' } })).not.toThrow();
    expect(hasSandboxCapacity(3)).toBe(true);
    expect(hasSandboxCapacity(4)).toBe(false);
    expect(isSandboxBusy(0)).toBe(false);
    expect(isSandboxBusy(1)).toBe(true);
    expect(boundedSandboxOutput('ghp_' + 'a'.repeat(30), 'Bearer ' + 'b'.repeat(30), 20)).toMatchObject({ truncated: true });
    const output = boundedSandboxOutput('Bearer ' + 'b'.repeat(30), '', 100);
    expect(output.stdout).toBe('Bearer [REDACTED]');
  });

  it('always routes sandbox filesystem operations through the selected container', () => {
    for (const operation of ['sandbox.fs.list', 'sandbox.fs.read']) {
      expect(buildSandboxFilesystemArgs({ runtimeId: 'selected-container', operation, path: 'src' }).slice(0, 4)).toEqual(['exec', 'selected-container', 'sh', '-c']);
    }
    expect(buildSandboxFilesystemArgs({ runtimeId: 'selected-container', operation: 'sandbox.fs.write', path: 'src/file.txt' }).slice(0, 5)).toEqual(['exec', '-i', 'selected-container', 'sh', '-c']);
  });

  it('builds sandbox execution commands with the selected runtime ID and validated cwd', () => {
    expect(buildSandboxExecArgs({ runtimeId: 'container-runtime-id', cwd: 'src', command: ['node', '-v'], env: { CI: 'true' } })).toEqual([
      'exec', '--workdir', '/workspace', '--env', 'CI=true', 'container-runtime-id', 'sh', '-c', expect.any(String), '--', 'src', 'node', '-v',
    ]);
    expect(() => buildSandboxExecArgs({ runtimeId: 'container-runtime-id', cwd: '', command: [''] })).toThrow('Invalid command argument');
  });


  it('rejects unknown operations and extra request properties', () => {
    expect(() => parseRuntimeRequest('{"operation":"exec","command":"id"}')).toThrow('Unsupported');
    expect(() => parseRuntimeRequest('{"operation":"container.list","command":"id"}')).toThrow('unsupported properties');
  });

  it('rejects malformed, oversized and non-object requests', () => {
    expect(() => parseRuntimeRequest('{')).toThrow('valid JSON');
    expect(() => parseRuntimeRequest('[]')).toThrow('object');
    expect(() => parseRuntimeRequest(' '.repeat(2 * 1024 * 1024 + 1))).toThrow('too large');
  });
});


describe('rootless workload lifecycle isolation', () => {
  it('requires the expected workload type for stop/remove lifecycle operations', () => {
    const record = { workloadType: 'project-service' };
    expect(() => assertWorkloadTypeMatch(record, 'task')).toThrow('type mismatch');
    expect(() => assertWorkloadTypeMatch(record, 'project-service')).not.toThrow();
  });

  it('builds only the hardened container create policy and never mounts a workspace implicitly', () => {
    const args = buildContainerCreateArgs({
      id: '134e5321-b4d7-4d4f-be92-ce56a984adaa',
      workloadType: 'task',
      repositoryId: 'deputy-proxy-vps-mcp',
      image: `docker.io/library/node@sha256:${'a'.repeat(64)}`,
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
      workspaceMount: null,
      executionMount: { path: '/var/lib/vps-sandbox/execution-logs/134e5321-b4d7-4d4f-be92-ce56a984adaa', destination: '/run/vps-mcp-executions' },
    });
    expect(args).toContain('--cgroup-parent');
    expect(args).toContain('/system.slice/vps-sandbox-runtime.service');
    expect(args).toContain('--network=none');
    expect(args).toContain('--userns=keep-id');
    expect(args).toContain('--user');
    expect(args).toContain('--security-opt=seccomp=/usr/share/containers/seccomp.json');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
    expect(args).toContain('--pids-limit');
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--pid=host');
    expect(args).not.toContain('--network=host');
    expect(args).toContain('type=bind,src=/var/lib/vps-sandbox/execution-logs/134e5321-b4d7-4d4f-be92-ce56a984adaa,dst=/run/vps-mcp-executions,rw');
    expect(args).not.toContain('/workspace');
  });
  it('allows task egress only through the administrator-pinned proxy network mode', () => {
    const image = 'docker.io/library/node@sha256:' + 'a'.repeat(64);
    const args = buildContainerCreateArgs({
      id: '134e5321-b4d7-4d4f-be92-ce56a984adaa',
      workloadType: 'task',
      repositoryId: 'deputy-proxy-vps-mcp',
      worktreeId: '234e5321-b4d7-4d4f-be92-ce56a984adaa',
      image,
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
      workspaceMount: null,
      executionMount: { path: '/var/lib/vps-sandbox/execution-logs/134e5321-b4d7-4d4f-be92-ce56a984adaa', destination: '/run/vps-mcp-executions' },
      network: 'slirp4netns:allow_host_loopback=true',
      proxyUrl: 'http://10.0.2.2:3128',
    });
    expect(args).toContain('--network=slirp4netns:allow_host_loopback=true');
    expect(args).not.toContain('--network=host');
    expect(() => buildContainerCreateArgs({
      id: '134e5321-b4d7-4d4f-be92-ce56a984adaa',
      workloadType: 'task',
      repositoryId: 'deputy-proxy-vps-mcp',
      worktreeId: '234e5321-b4d7-4d4f-be92-ce56a984adaa',
      image,
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
      workspaceMount: null,
      executionMount: { path: '/var/lib/vps-sandbox/execution-logs/134e5321-b4d7-4d4f-be92-ce56a984adaa', destination: '/run/vps-mcp-executions' },
      network: 'slirp4netns:allow_host_loopback=true',
      proxyUrl: 'http://attacker.invalid:3128',
    })).toThrow('Unsupported workload network policy');
  });

});

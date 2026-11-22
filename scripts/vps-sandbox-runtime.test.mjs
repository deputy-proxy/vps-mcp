import { describe, expect, it } from 'vitest';
import { assertWorkloadTypeMatch, buildContainerCreateArgs, parseRuntimeRequest } from './vps-sandbox-runtime.mjs';

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

  it('rejects unknown operations and extra request properties', () => {
    expect(() => parseRuntimeRequest('{"operation":"exec","command":"id"}')).toThrow('Unsupported');
    expect(() => parseRuntimeRequest('{"operation":"container.list","command":"id"}')).toThrow('unsupported properties');
  });

  it('rejects malformed, oversized and non-object requests', () => {
    expect(() => parseRuntimeRequest('{')).toThrow('valid JSON');
    expect(() => parseRuntimeRequest('[]')).toThrow('object');
    expect(() => parseRuntimeRequest(' '.repeat(32 * 1024 + 1))).toThrow('too large');
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
    });
    expect(args).toContain('--network=none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
    expect(args).toContain('--pids-limit');
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--pid=host');
    expect(args).not.toContain('--network=host');
    expect(args).not.toContain('--mount');
  });
});

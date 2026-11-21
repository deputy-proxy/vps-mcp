import { describe, expect, it } from 'vitest';
import { evaluateSnapshot } from './rootless-runtime-preflight.mjs';

const readySnapshot = {
  platform: 'linux', cgroup: 'cgroup2fs', userNamespace: true,
  subuid: true, subgid: true, newuidmap: true, newgidmap: true,
  slirp4netns: true, pasta: false, fuseOverlayfs: true,
  podman: true, podmanVersion: 'podman version 5.0.0',
  unitReadable: true, noNewPrivileges: false,
  protectSystem: 'strict', protectControlGroups: true,
  serviceContextProbe: true, storageWritable: true,
  memoryBytes: 8 * 1024 ** 3, diskAvailableBytes: 50 * 1024 ** 3,
};

describe('rootless runtime preflight', () => {
  it('accepts a host that satisfies every required prerequisite', () => {
    expect(evaluateSnapshot(readySnapshot).ready).toBe(true);
  });

  it('blocks when user namespaces are unavailable', () => {
    const result = evaluateSnapshot({ ...readySnapshot, userNamespace: false });
    expect(result.ready).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain('user-namespaces');
  });

  it('reports NoNewPrivileges incompatibility with setuid mapping helpers', () => {
    const result = evaluateSnapshot({ ...readySnapshot, noNewPrivileges: true });
    expect(result.checks.find((check) => check.id === 'setuid-helper-compatibility')?.status).toBe('warning');
  });

  it('does not treat a missing optional overlay helper as a hard blocker', () => {
    const result = evaluateSnapshot({ ...readySnapshot, fuseOverlayfs: false });
    expect(result.ready).toBe(true);
    expect(result.checks.find((check) => check.id === 'overlay-helper')?.status).toBe('warning');
  });
});

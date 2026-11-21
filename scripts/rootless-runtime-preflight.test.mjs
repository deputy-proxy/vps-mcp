import { describe, expect, it } from 'vitest';
import { evaluateSnapshot } from './rootless-runtime-preflight.mjs';

const readySnapshot = {
  platform: 'linux', executionUser: 'vps-sandbox', cgroup: 'cgroup2fs', cgroupDelegation: true, userManagerBus: true, userManagerDelegation: true, userNamespace: true,
  subuid: true, subgid: true, newuidmap: true, newgidmap: true,
  slirp4netns: true, pasta: false, fuseOverlayfs: true,
  podman: true, podmanVersion: 'podman version 5.0.0',
  noNewPrivileges: false, capSetuid: true, capSetgid: true,
  storageWritable: true, memoryBytes: 8 * 1024 ** 3, diskAvailableBytes: 50 * 1024 ** 3,
};

describe('rootless runtime preflight', () => {
  it('accepts a dedicated runtime context that satisfies every required prerequisite', () => {
    expect(evaluateSnapshot(readySnapshot).ready).toBe(true);
  });

  it('blocks when the process is not running as the dedicated runtime identity', () => {
    const result = evaluateSnapshot({ ...readySnapshot, executionUser: 'vps-mcp' });
    expect(result.ready).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain('runtime-identity');
  });

  it('blocks when the systemd user manager bus is unavailable', () => {
    const result = evaluateSnapshot({ ...readySnapshot, userManagerBus: false });
    expect(result.ready).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain('systemd-user-manager');
  });

  it('blocks when the systemd user manager does not delegate resource controllers', () => {
    const result = evaluateSnapshot({ ...readySnapshot, userManagerDelegation: false });
    expect(result.ready).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain('systemd-user-manager-delegation');
  });

  it('blocks when CPU, memory and PID cgroup delegation is unavailable', () => {
    const result = evaluateSnapshot({ ...readySnapshot, cgroupDelegation: false });
    expect(result.ready).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain('cgroup-delegation');
  });

  it('blocks when the capability bounding set excludes mapping-helper capabilities', () => {
    const result = evaluateSnapshot({ ...readySnapshot, capSetuid: false, capSetgid: false });
    expect(result.ready).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain('mapping-helper-capabilities');
  });

  it('accepts Podman user namespaces even when generic unshare is restricted', () => {
    const result = evaluateSnapshot({ ...readySnapshot, genericUnshare: false, userNamespace: true });
    expect(result.ready).toBe(true);
  });

  it('blocks when Podman cannot create a user namespace', () => {
    const result = evaluateSnapshot({ ...readySnapshot, userNamespace: false });
    expect(result.ready).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain('user-namespaces');
  });

  it('blocks when NoNewPrivileges prevents mapping-helper privilege gain', () => {
    const result = evaluateSnapshot({ ...readySnapshot, noNewPrivileges: true });
    expect(result.ready).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain('no-new-privileges');
  });

  it('blocks when effective NoNewPrivileges cannot be read', () => {
    const result = evaluateSnapshot({ ...readySnapshot, noNewPrivileges: null });
    expect(result.ready).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain('no-new-privileges');
  });

  it('blocks when the rootless container storage directory is not writable', () => {
    const result = evaluateSnapshot({ ...readySnapshot, storageWritable: false });
    expect(result.ready).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain('storage-writable');
  });

  it('does not treat a missing optional overlay helper as a hard blocker', () => {
    const result = evaluateSnapshot({ ...readySnapshot, fuseOverlayfs: false });
    expect(result.ready).toBe(true);
    expect(result.checks.find((check) => check.id === 'overlay-helper')?.status).toBe('warning');
  });
});

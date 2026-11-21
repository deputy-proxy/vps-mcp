import { describe, expect, it } from 'vitest';
import { buildSystemdRunArgs } from './vps-sandboxctl.mjs';

describe('privileged runtime helper command construction', () => {
  it('builds a fixed transient systemd boundary for the selected operation', () => {
    const args = buildSystemdRunArgs('smoke', 'vps-sandboxctl-smoke-1234', '995');
    expect(args).toContain('--uid=vps-sandbox');
    expect(args).toContain('--property=Delegate=cpu memory pids');
    expect(args).toContain('--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/995/bus');
    expect(args.at(-1)).toContain('--cgroup-manager=systemd');
    expect(args).toContain('--property=NoNewPrivileges=no');
    expect(args).toContain('--property=CapabilityBoundingSet=CAP_SETUID CAP_SETGID');
    expect(args.at(-3)).toBe('/usr/bin/bash');
    expect(args.at(-1)).toContain('docker.io/library/alpine:3.21');
    const acceptance = buildSystemdRunArgs('acceptance', 'vps-sandboxctl-acceptance-1234', '995');
    expect(acceptance.at(-1)).toContain('/usr/local/libexec/vps-mcp/rootless-runtime-acceptance.mjs');
  });

  it('rejects arbitrary operation names, unit names and UIDs', () => {
    expect(() => buildSystemdRunArgs('shell', 'vps-sandboxctl-smoke-1234', '995')).toThrow('Unsupported');
    expect(() => buildSystemdRunArgs('acceptance', 'vps-sandboxctl-acceptance-1234;id', '995')).toThrow('Invalid transient');
    expect(() => buildSystemdRunArgs('smoke', 'vps-sandboxctl-smoke-1234;id', '995')).toThrow('Invalid transient');
    expect(() => buildSystemdRunArgs('smoke', 'vps-sandboxctl-smoke-1234', '995;id')).toThrow('Invalid sandbox UID');
  });
});

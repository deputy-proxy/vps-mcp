import { describe, expect, it } from 'vitest';
import { buildSystemdRunArgs } from './vps-sandboxctl.mjs';

describe('privileged runtime helper command construction', () => {
  it('builds a fixed transient systemd boundary for the selected operation', () => {
    const args = buildSystemdRunArgs('smoke', 'vps-sandboxctl-smoke-1234', '995');
    expect(args[0]).toBe('--system');
    expect(args).toContain('--uid=vps-sandbox');
    expect(args).toContain('--setenv=VPS_SANDBOXCTL_UNIT=vps-sandboxctl-smoke-1234');
    expect(args).toContain('--property=Delegate=cpu memory pids');
    expect(args).toContain('--property=DelegateSubgroup=init.scope');
    expect(args.at(-1)).toContain('CURRENT_CGROUP=$(awk -F: \'$1 == "0" { print $3 }\' "/proc/$$/cgroup")');
    expect(args.at(-1)).toContain('test -z "$(cat "$DELEGATED_CGROUP/cgroup.procs")"');
    expect(args.at(-1)).not.toContain('echo "$$" > "$INIT_CGROUP/cgroup.procs"');
    expect(args).toContain('--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/995/bus');
    expect(args.at(-1)).toContain('--cgroup-manager=cgroupfs');
    expect(args).toContain('--property=NoNewPrivileges=no');
    expect(args.at(-1)).toContain('systemctl show');
    expect(args.at(-1)).toContain('INVOCATION_ID');
    expect(args.at(-1)).not.toContain('/proc/self/cgroup');
    expect(args.at(-1)).not.toContain('/sys/fs/cgroup/system.slice');
    expect(args.at(-1)).toContain('DELEGATED_CGROUP="$MOUNT_ROOT$CGROUP"');
    expect(args.at(-1)).toContain('test -d "$DELEGATED_CGROUP"');
    expect(args.at(-1)).toContain('test -w "$DELEGATED_CGROUP/cgroup.subtree_control"');
    expect(args.at(-1)).toContain('INIT_CGROUP="$DELEGATED_CGROUP/init.scope"');
    expect(args.at(-1)).toContain('for CONTROLLER in cpu memory pids; do echo "+$CONTROLLER" > "$DELEGATED_CGROUP/cgroup.subtree_control"');
    expect(args.at(-1)).toContain('export VPS_SANDBOXCTL_CGROUP="$CGROUP"');
    expect(args.at(-1)).toContain('--cgroup-parent="$CGROUP"');
    expect(args.at(-1)).not.toContain('test -w "$MOUNT_ROOT/cgroup.subtree_control"');
    expect(args).toContain('--property=Delegate=cpu memory pids');
    expect(args).toContain('--property=ProtectSystem=strict');
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

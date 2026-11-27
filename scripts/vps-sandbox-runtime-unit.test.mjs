import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const unit = readFileSync(new URL('../systemd/vps-sandbox-runtime.service', import.meta.url), 'utf8');

describe('rootless runtime systemd unit', () => {
  it('allows Podman to preserve setuid/setgid metadata during image layer extraction', () => {
    expect(unit).toContain('RestrictSUIDSGID=no');
    expect(unit).not.toMatch(/^RestrictSUIDSGID=yes$/m);
  });

  it('retains the runtime service filesystem and capability boundaries', () => {
    expect(unit).toContain('User=vps-sandbox');
    expect(unit).toContain('CapabilityBoundingSet=CAP_SETUID CAP_SETGID');
    expect(unit).toContain('ProtectSystem=strict');
    expect(unit).toContain('ProtectHome=read-only');
    expect(unit).toContain('NoNewPrivileges=no');
    expect(unit).toContain('DevicePolicy=closed');
    expect(unit).toContain('ReadWritePaths=/var/lib/vps-sandbox /var/lib/vps-sandbox-mounts');
  });
});

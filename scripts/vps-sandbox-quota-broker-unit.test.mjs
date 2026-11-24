import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const unit = readFileSync(new URL('../systemd/vps-sandbox-quota-broker.service', import.meta.url), 'utf8');
const helper = readFileSync(new URL('./vps-sandbox-quota-helper.mjs', import.meta.url), 'utf8');

describe('quota broker host mount namespace', () => {
  it('does not enable systemd filesystem isolation that creates a private mount namespace', () => {
    for (const directive of ['ProtectSystem=', 'ProtectHome=', 'PrivateTmp=', 'PrivateMounts=', 'ReadWritePaths=']) {
      expect(unit).not.toContain(directive);
    }
    expect(unit).toContain('CapabilityBoundingSet=CAP_SYS_ADMIN CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE');
  });

  it('mounts and unmounts staging paths directly in the broker mount namespace', () => {
    expect(helper).toContain("run('/usr/bin/mount',['--bind',workspace,target],30000)");
    expect(helper).toContain("run('/usr/bin/umount',['--',target],30000)");
    expect(helper).not.toContain('/usr/bin/nsenter');
  });
});

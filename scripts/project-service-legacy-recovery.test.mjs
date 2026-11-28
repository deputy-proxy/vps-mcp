import { describe, expect, it } from 'vitest';
import { projectServiceBootRecoveryAction } from './vps-sandbox-runtime.mjs';

describe('legacy project-service boot recovery', () => {
  const record = (status) => ({
    workloadType: 'project-service',
    status,
    projectMounts: {
      releaseId: '18800000-0000-4000-8000-000000000001',
      release: '/var/lib/vps-sandbox-mounts/projects/repo/workload/release',
      storage: '/var/lib/vps-sandbox-mounts/projects/repo/workload/storage',
      cache: '/var/lib/vps-sandbox-mounts/projects/repo/workload/cache',
      logs: '/var/lib/vps-sandbox-mounts/projects/repo/workload/logs',
    },
  });

  it('requires operator review when a legacy workload has no runtime container', () => {
    for (const status of ['creating', 'created', 'stopped', 'running', 'removing']) {
      expect(projectServiceBootRecoveryAction(record(status), 'missing')).toBe('operator-review');
    }
  });

  it('stops a running legacy container but never removes a removed record', () => {
    expect(projectServiceBootRecoveryAction(record('running'), 'running')).toBe('stop');
    expect(projectServiceBootRecoveryAction(record('removed'), 'missing')).toBe('skip');
  });
});

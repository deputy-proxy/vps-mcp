import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EXECUTION_POLICY,
  buildExecutionCancelScript,
  buildExecutionIdentityCheckScript,
  buildExecutionRunnerScript,
  executionRetentionActions,
  assertExecutionLogQuota,
  executionLogReadWindow,
  buildExecutionStartArgs,
  createExecutionRecord,
  executionCommandMetadata,
  safeExecutionId,
} from './executions.mjs';

const sandboxId = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
const executionId = '234e5321-b4d7-4d4f-be92-ce56a984adaa';

async function executionFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-mcp-execution-test-'));
  const workspace = path.join(root, 'workspace');
  const executionRoot = path.join(root, 'executions');
  await fs.mkdir(workspace);
  await fs.mkdir(executionRoot);
  const script = buildExecutionRunnerScript()
    .replace('root=/workspace', 'root=' + workspace)
    .replace('exec_root=/run/vps-mcp-executions', 'exec_root=' + executionRoot)
    .replaceAll('setsid sh -c', 'setsid /bin/bash -c');
  return { root, workspace, executionRoot, script };
}

function runRunner(script, id, timeoutSeconds, maxLogBytes, command) {
  return spawnSync('/usr/bin/setsid', [
    '/bin/bash', '-c', script, '--', id, '', String(timeoutSeconds), String(maxLogBytes), ...command,
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
}

describe('durable sandbox execution contracts', () => {
  it('uses immutable execution IDs, bounded quotas and explicit retention', () => {
    expect(safeExecutionId(executionId)).toBe(executionId);
    expect(() => safeExecutionId('../not-an-id')).toThrow('Invalid execution ID');
    expect(executionRetentionActions({ status: 'running', logsExpireAt: '2020-01-01T00:00:00.000Z', recordExpireAt: '2020-01-01T00:00:00.000Z' }, Date.now())).toEqual({ expireLogs: false, deleteRecord: false });
    expect(executionRetentionActions({ status: 'completed', logsExpireAt: '2020-01-01T00:00:00.000Z', recordExpireAt: '2020-01-01T00:00:00.000Z' }, Date.now())).toEqual({ expireLogs: true, deleteRecord: true });
    expect(EXECUTION_POLICY).toMatchObject({
      maxLogBytes: 2 * 1024 * 1024,
      maxLogBytesPerSandbox: 32 * 1024 * 1024,
      maxLogBytesGlobal: 512 * 1024 * 1024,
      maxActivePerSandbox: 1,
      maxActiveGlobal: 8,
      logRetentionMs: 7 * 24 * 60 * 60 * 1000,
      recordRetentionMs: 30 * 24 * 60 * 60 * 1000,
    });
  });

  it('supports stable caller-supplied execution IDs and request fingerprints', () => {
    const executionId = '234e5321-b4d7-4d4f-be92-ce56a984adaa';
    const record = createExecutionRecord({ sandboxId, runtimeId: 'a'.repeat(64), command: ['node', '-v'], cwd: '', timeoutMs: 30_000,
      id: executionId, requestFingerprint: 'b'.repeat(64), now: new Date('2026-11-22T00:00:00.000Z') });
    expect(record.id).toBe(executionId);
    expect(record.requestFingerprint).toBe('b'.repeat(64));
  });

  it('persists only a redacted command summary and fingerprint, never raw arguments', () => {
    const command = ['node', '--token', 'ghp_' + 'a'.repeat(30)];
    const metadata = executionCommandMetadata(command);
    expect(metadata.executable).toBe('node');
    expect(metadata.argumentCount).toBe(3);
    expect(metadata.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(executionCommandMetadata(['Bearer abcdefghijklmnopqrstuvwxyz']).executable).toBe('Bearer [REDACTED]');
    const record = createExecutionRecord({
      sandboxId, runtimeId: 'a'.repeat(64), command, cwd: 'src', timeoutMs: 60_000,
      now: new Date('2026-11-22T00:00:00.000Z'),
    });
    expect(JSON.stringify(record)).not.toContain(command[2]);
    expect(record).toMatchObject({
      sandboxId, status: 'starting', cwd: 'src', runtimeIdentity: { marker: record.id },
      logsExpireAt: '2026-11-29T00:00:00.000Z',
      recordExpireAt: '2026-12-22T00:00:00.000Z',
    });
  });

  it('enforces global and per-sandbox disk quotas and bounded log read windows', () => {
    expect(assertExecutionLogQuota({ globalBytes: 0, sandboxBytes: 0 })).toBe(true);
    expect(() => assertExecutionLogQuota({ globalBytes: EXECUTION_POLICY.maxLogBytesGlobal, sandboxBytes: 0 })).toThrow('global execution log budget');
    expect(() => assertExecutionLogQuota({ globalBytes: 0, sandboxBytes: EXECUTION_POLICY.maxLogBytesPerSandbox })).toThrow('sandbox execution log budget');
    expect(executionLogReadWindow(1000, undefined, 256)).toEqual({ offset: 744, length: 256, nextOffset: 1000, hasMore: false });
    expect(executionLogReadWindow(1000, 256, 256)).toEqual({ offset: 256, length: 256, nextOffset: 512, hasMore: true });
  });

  it('builds sandbox-only detached execution requests with validated argv and bounded timeout', () => {
    const args = buildExecutionStartArgs({
      runtimeId: 'a'.repeat(64), executionId, cwd: 'src',
      timeoutMs: 120_000, maxLogBytes: 1024, command: ['node', 'build.js'],
    });
    expect(args.slice(0, 6)).toEqual(['exec', '--detach', 'a'.repeat(64), 'setsid', 'sh', '-c']);
    expect(args.slice(-6)).toEqual([executionId, 'src', '120', '1024', 'node', 'build.js']);
    expect(() => buildExecutionStartArgs({
      runtimeId: 'a'.repeat(64), executionId, cwd: '../etc',
      timeoutMs: 120_000, command: ['id'],
    })).toThrow('workspace-relative');
    expect(() => buildExecutionStartArgs({
      runtimeId: 'a'.repeat(64), executionId, timeoutMs: 90_000_000, command: ['id'],
    })).toThrow('timeoutMs');
  });

  it('runs the command in a dedicated process group and persists bounded combined output and exit status', async () => {
    const fixture = await executionFixture();
    try {
      const result = runRunner(fixture.script, executionId, 30, 4096, ['/bin/sh', '-c', 'printf stdout; printf stderr >&2; exit 7']);
      expect(result.status).toBe(0);
      expect(await fs.readFile(path.join(fixture.executionRoot, executionId + '.log'), 'utf8')).toBe('stdoutstderr');
      expect(await fs.readFile(path.join(fixture.executionRoot, executionId + '.status'), 'utf8')).toBe('7\n');
      const identity = (await fs.readFile(path.join(fixture.executionRoot, executionId + '.identity'), 'utf8')).trim().split(/\s+/);
      expect(identity).toHaveLength(3);
      expect(Number(identity[0])).toBeGreaterThan(1);
      expect(identity[0]).toBe(identity[1]);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('caps the persisted log at the configured byte limit and records the extra-byte truncation sentinel', async () => {
    const fixture = await executionFixture();
    try {
      const result = runRunner(fixture.script, executionId, 30, 1024, ['/bin/sh', '-c', 'head -c 4096 /dev/zero']);
      expect(result.status).toBe(0);
      const log = await fs.readFile(path.join(fixture.executionRoot, executionId + '.log'));
      expect(log.length).toBe(1025);
      expect(await fs.readFile(path.join(fixture.executionRoot, executionId + '.status'), 'utf8')).toBe('0\n');
      await fs.truncate(path.join(fixture.executionRoot, executionId + '.log'), 1024);
      expect((await fs.stat(path.join(fixture.executionRoot, executionId + '.log'))).size).toBe(1024);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('cancels only the selected execution process group with a bounded grace period', async () => {
    const fixture = await executionFixture();
    let child;
    try {
      child = spawn('/usr/bin/setsid', [
        '/bin/bash', '-c', fixture.script, '--', executionId, '', '60', '4096', '/bin/sh', '-c', 'trap \"\" TERM; exec /bin/sleep 30',
      ], { stdio: 'ignore' });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await fs.access(path.join(fixture.executionRoot, executionId + '.identity'));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      const [pid, processGroup, startTime] = (await fs.readFile(path.join(fixture.executionRoot, executionId + '.identity'), 'utf8')).trim().split(' ');
      const cancel = buildExecutionCancelScript().replaceAll('/run/vps-mcp-executions', fixture.executionRoot)
        .replaceAll('kill -TERM -"$process_group"', 'kill -TERM -- -"$process_group"')
        .replaceAll('kill -KILL -"$process_group"', 'kill -KILL -- -"$process_group"');
      const result = spawnSync('/bin/bash', ['-c', cancel, '--', executionId, 'cancelled', pid, processGroup, startTime], {
        encoding: 'utf8', timeout: 6000,
      });
      expect(result.status).toBe(0);
      const exit = await Promise.race([
        new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal }))),
        new Promise((resolve) => setTimeout(() => resolve('still-running'), 1000)),
      ]);
      expect(exit).not.toBe('still-running');
      expect(await fs.readFile(path.join(fixture.executionRoot, executionId + '.reason'), 'utf8')).toBe('cancelled\n');
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('enforces command timeout independently of the MCP caller', async () => {
    const fixture = await executionFixture();
    try {
      const result = runRunner(fixture.script, executionId, 1, 4096, ['/bin/sleep', '30']);
      expect(result.status).toBe(0);
      expect(await fs.readFile(path.join(fixture.executionRoot, executionId + '.reason'), 'utf8')).toBe('timeout\n');
      await expect(fs.readFile(path.join(fixture.executionRoot, executionId + '.status'), 'utf8')).rejects.toThrow();
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('validates a process identity inside the container rather than a host PID', () => {
    expect(buildExecutionIdentityCheckScript()).toContain('/proc/$pid/stat');
    expect(buildExecutionIdentityCheckScript()).toContain('expected_start');
    expect(buildExecutionIdentityCheckScript()).toContain('ps -o pgid,stat');
    expect(buildExecutionIdentityCheckScript()).toContain('state=');
    expect(buildExecutionIdentityCheckScript()).toContain('\"$state\" != Z');
    expect(buildExecutionCancelScript()).toContain('kill -TERM -"$process_group"');
    expect(buildExecutionCancelScript()).not.toContain('process.kill');
  });
});

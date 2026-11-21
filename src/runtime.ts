import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HELPER = '/usr/local/sbin/vps-sandboxctl';
const OPERATIONS = ['preflight', 'info', 'smoke'] as const;
export type RuntimeOperation = typeof OPERATIONS[number];

export function isRuntimeOperation(value: string): value is RuntimeOperation {
  return (OPERATIONS as readonly string[]).includes(value);
}

export async function runRuntimeOperation(operation: RuntimeOperation): Promise<{
  operation: RuntimeOperation;
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync('/usr/bin/sudo', ['-n', HELPER, operation], {
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 1_048_576,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    return { operation, exitCode: 0, stdout, stderr };
  } catch (error) {
    const result = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    if (result.code === 'ENOENT') {
      throw new Error(`Required privileged helper is not installed at ${HELPER}. Ask an administrator to run scripts/install-vps-sandboxctl.sh.`);
    }
    if (result.code === 'EACCES') throw new Error(`MCP cannot execute ${HELPER}; verify its root-owned executable permissions.`);
    if (typeof result.code === 'number') {
      return { operation, exitCode: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
    throw new Error(result.stderr?.trim() || result.message || 'Runtime operation failed');
  }
}

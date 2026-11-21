import net from 'node:net';

const SOCKET_PATH = '/run/vps-sandboxctl.sock';
const OPERATIONS = ['preflight', 'info', 'smoke', 'acceptance'] as const;
export type RuntimeOperation = typeof OPERATIONS[number];

type RuntimeResult = {
  operation: RuntimeOperation;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function isRuntimeOperation(value: string): value is RuntimeOperation {
  return (OPERATIONS as readonly string[]).includes(value);
}

export async function runRuntimeOperation(operation: RuntimeOperation): Promise<RuntimeResult> {
  if (!isRuntimeOperation(operation)) throw new Error('Unsupported runtime operation');

  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    let response = '';
    let settled = false;

    const finish = (error?: Error, result?: RuntimeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result!);
    };

    socket.setTimeout(915_000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ operation })}\n`));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (Buffer.byteLength(response, 'utf8') > 1_100_000) {
        finish(new Error('Runtime broker response exceeded the allowed size.'));
      }
    });
    socket.on('end', () => {
      try {
        const result = JSON.parse(response.trim()) as RuntimeResult | { error: string };
        if ('error' in result) finish(new Error(result.error));
        else if (result.operation !== operation || typeof result.exitCode !== 'number') {
          finish(new Error('Runtime broker returned an invalid response.'));
        } else finish(undefined, result);
      } catch {
        finish(new Error('Runtime broker returned an invalid response.'));
      }
    });
    socket.on('timeout', () => finish(new Error('Runtime broker operation timed out.')));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        finish(new Error(`Runtime broker is not installed or active at ${SOCKET_PATH}. Run scripts/install-vps-sandboxctl.sh as root.`));
      } else if (error.code === 'EACCES') {
        finish(new Error(`MCP cannot access ${SOCKET_PATH}; verify the socket group and mode.`));
      } else finish(error);
    });
  });
}

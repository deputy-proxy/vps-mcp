#!/usr/bin/node
import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HELPER = '/usr/local/libexec/vps-mcp/vps-sandboxctl.mjs';
const OPERATIONS = new Set(['preflight', 'info', 'smoke', 'acceptance']);
const MAX_REQUEST_BYTES = 256;
const MAX_OUTPUT_BYTES = 1_048_576;
const OPERATION_TIMEOUT_MS = 900_000;
let operationInProgress = false;

export function parseBrokerRequest(raw) {
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) throw new Error('Request is too large');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Request must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be an object');
  if (Object.keys(value).length !== 1 || !OPERATIONS.has(value.operation)) throw new Error('Unsupported runtime operation');
  return value.operation;
}

export async function executeBrokerOperation(operation) {
  if (!OPERATIONS.has(operation)) throw new Error('Unsupported runtime operation');
  try {
    const { stdout, stderr } = await execFileAsync('/usr/bin/node', [HELPER, operation], {
      encoding: 'utf8',
      timeout: OPERATION_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', SYSTEMD_COLORS: '0' },
    });
    return { operation, exitCode: 0, stdout, stderr };
  } catch (error) {
    const result = error;
    if (typeof result.code === 'number') {
      return { operation, exitCode: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
    return {
      operation,
      exitCode: 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.message ?? 'Runtime operation failed',
    };
  }
}

function respond(socket, payload) {
  if (!socket.destroyed) socket.end(`${JSON.stringify(payload)}\n`);
}

function handleConnection(socket) {
  let input = '';
  let handled = false;
  socket.setTimeout(OPERATION_TIMEOUT_MS + 15_000);

  socket.on('data', async (chunk) => {
    if (handled) {
      socket.destroy();
      return;
    }
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
      handled = true;
      respond(socket, { error: 'Request is too large' });
      return;
    }
    const newline = input.indexOf('\n');
    if (newline === -1) return;
    handled = true;
    if (newline !== input.length - 1) {
      respond(socket, { error: 'Only one request is allowed per connection' });
      return;
    }
    try {
      const operation = parseBrokerRequest(input.slice(0, newline));
      if (operationInProgress) {
        respond(socket, { error: 'Another runtime acceptance operation is already running' });
        return;
      }
      operationInProgress = true;
      try {
        respond(socket, await executeBrokerOperation(operation));
      } finally {
        operationInProgress = false;
      }
    } catch (error) {
      respond(socket, { error: error.message });
    }
  });

  socket.on('error', () => {});
  socket.on('timeout', () => socket.destroy());
}

function main() {
  if (process.getuid() !== 0) {
    console.error('The runtime broker must run as root.');
    process.exit(77);
  }
  if (process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '1') {
    console.error('The runtime broker must be started by its systemd socket unit.');
    process.exit(77);
  }

  const server = net.createServer(handleConnection);
  server.on('error', (error) => {
    console.error(error.message);
    process.exit(1);
  });
  server.listen({ fd: 3 });
}

if (import.meta.url === `file://${process.argv[1]}`) main();

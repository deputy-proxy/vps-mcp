#!/usr/bin/node
import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HELPER = '/usr/local/libexec/vps-mcp/vps-sandbox-quota-helper.mjs';
const MAX_REQUEST_BYTES = 1024;
const NEWLINE = String.fromCharCode(10);
let quotaQueue = Promise.resolve();

export function parseQuotaBrokerRequest(raw) {
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) throw new Error('Request is too large');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('Request must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be an object');
  const keys = Object.keys(value).sort().join(',');
  const expected = value.operation === 'apply' ? 'diskMiB,operation,repositoryId,worktreeId' : value.operation === 'apply-project' ? 'diskMiB,operation,repositoryId,workloadId' : ['stage','unstage'].includes(value.operation) ? 'operation,repositoryId,workloadId,worktreeId' : ['stage-project','unstage-project'].includes(value.operation) ? 'operation,releaseId,repositoryId,workloadId' : '';
  if (!expected || keys !== expected) throw new Error('Unsupported quota operation or properties');
  if (typeof value.repositoryId !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,199}$/i.test(value.repositoryId)) throw new Error('Invalid repository ID');
  if (['apply','stage','unstage'].includes(value.operation) && (typeof value.worktreeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.worktreeId))) throw new Error('Invalid worktree ID');
  if (['apply','apply-project'].includes(value.operation) && (!Number.isInteger(value.diskMiB) || value.diskMiB < 128 || value.diskMiB > 102400)) throw new Error('diskMiB must be between 128 and 102400');
  if (value.operation !== 'apply' && (typeof value.workloadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.workloadId))) throw new Error('Invalid workload ID');
  if (['stage-project','unstage-project'].includes(value.operation) && (typeof value.releaseId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.releaseId))) throw new Error('Invalid project release ID');
  return value;
}

export async function applyQuotaRequest(value) {
  const args = value.operation === 'apply' ? ['apply', value.repositoryId, value.worktreeId, String(value.diskMiB)] : value.operation === 'apply-project' ? ['apply-project', value.repositoryId, value.workloadId, String(value.diskMiB)] : ['stage','unstage'].includes(value.operation) ? [value.operation, value.repositoryId, value.worktreeId, value.workloadId] : [value.operation, value.repositoryId, value.workloadId, value.releaseId];
  const result = await exec('/usr/bin/node', [HELPER, ...args], {
    encoding: 'utf8', timeout: value.operation === 'apply-project' ? 130000 : 45000, maxBuffer: 8192, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', ...(process.env.VPS_SANDBOX_PROJECT_ENV_ROOT ? { VPS_SANDBOX_PROJECT_ENV_ROOT: process.env.VPS_SANDBOX_PROJECT_ENV_ROOT } : {}), ...(process.env.VPS_SANDBOX_PROJECT_ENV_OWNER ? { VPS_SANDBOX_PROJECT_ENV_OWNER: process.env.VPS_SANDBOX_PROJECT_ENV_OWNER } : {}) },
  });
  return JSON.parse(result.stdout.trim());
}
export const performQuotaBrokerRequest = applyQuotaRequest;

function respond(socket, value) {
  if (!socket.destroyed) socket.end(JSON.stringify(value) + NEWLINE);
}

function handleConnection(socket) {
  let input = '';
  let handled = false;
  socket.setTimeout(60000);
  socket.on('data', async (chunk) => {
    if (handled) return socket.destroy();
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
      handled = true;
      return respond(socket, { error: 'Request is too large' });
    }
    const end = input.indexOf(NEWLINE);
    if (end < 0) return;
    handled = true;
    if (end !== input.length - 1) return respond(socket, { error: 'Only one request is allowed per connection' });
    let request;
    try { request = parseQuotaBrokerRequest(input.slice(0, end)); }
    catch (error) { return respond(socket, { error: error.message }); }
    const operation = quotaQueue.then(() => applyQuotaRequest(request));
    quotaQueue = operation.then(() => undefined, () => undefined);
    try { respond(socket, await operation); }
    catch (error) { respond(socket, { error: error.message || 'Quota operation failed' }); }
  });
  socket.on('error', () => {});
  socket.on('timeout', () => socket.destroy());
}

function main() {
  if (process.getuid() !== 0 || process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '1') process.exit(77);
  const server = net.createServer(handleConnection);
  server.on('error', (error) => { console.error(error.message); process.exit(1); });
  server.listen({ fd: 3 });
}

if (import.meta.url === 'file://' + process.argv[1]) main();

#!/usr/bin/env node
import net from 'node:net';

const socketPath = process.env.VPS_SANDBOX_RUNTIME_SOCKET ?? '/run/vps-sandbox-runtime.sock';
if (!socketPath.startsWith('/run/')) throw new Error('Runtime recovery socket must be under /run');

const response = await new Promise((resolve, reject) => {
  const socket = net.createConnection({ path: socketPath });
  let buffer = '';
  const timeout = setTimeout(() => {
    socket.destroy();
    reject(new Error('Timed out waiting for project-service recovery'));
  }, 240_000);
  socket.once('connect', () => socket.write(JSON.stringify({ operation: 'project-service.recover' }) + '\n'));
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    clearTimeout(timeout);
    socket.end();
    try {
      const message = JSON.parse(buffer.slice(0, newline));
      if (message.error) reject(new Error(message.error.message ?? 'Project-service recovery failed'));
      else resolve(message.result ?? {});
    } catch (error) { reject(error); }
  });
  socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
});

process.stdout.write(JSON.stringify(response) + '\n');
if (response.operatorReview > 0) process.exitCode = 1;

#!/usr/bin/env node
import net from 'node:net';

const socketPath = process.env.VPS_SANDBOX_RUNTIME_SOCKET ?? '/run/vps-sandbox-runtime.sock';
if (!socketPath.startsWith('/run/')) throw new Error('Runtime recovery socket must be under /run');

async function request(operation, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for ${operation}`));
    }, timeoutMs);
    socket.once('connect', () => socket.write(JSON.stringify({ operation }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        if (message.error) reject(new Error(message.error.message ?? `${operation} failed`));
        else resolve(message.result ?? {});
      } catch (error) { reject(error); }
    });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

const projectServices = await request('project-service.recover', 210_000);
const projectDependencies = await request('project-dependency.recover', 60_000);
const response = { projectServices, projectDependencies };
process.stdout.write(JSON.stringify(response) + '\n');
if (projectServices.operatorReview > 0 || projectDependencies.operatorReview > 0) process.exitCode = 1;

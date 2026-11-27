import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROJECT_ENV_ROOTS_KEY = 'VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON';

export function validateProjectEnvironmentRoots(value) {
  let roots = value;
  if (typeof value === 'string') {
    try {
      roots = JSON.parse(value);
    } catch {
      throw new Error('Project environment roots must be valid JSON');
    }
  }

  if (!Array.isArray(roots) || roots.length < 1 || roots.length > 8) {
    throw new Error('Project environment roots must contain between 1 and 8 entries');
  }

  const seenRoots = new Set();
  const seenOwners = new Set();

  return roots.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.root !== 'string' || !path.isAbsolute(entry.root)
      || path.resolve(entry.root) !== entry.root || entry.root === '/'
      || entry.root.includes(',') || /[\0\r\n]/.test(entry.root)
      || typeof entry.owner !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(entry.owner)) {
      throw new Error('Project environment root configuration contains an invalid entry');
    }

    if (seenRoots.has(entry.root) || seenOwners.has(entry.owner)) {
      throw new Error('Project environment roots and owners must be unique');
    }

    seenRoots.add(entry.root);
    seenOwners.add(entry.owner);
    return { root: entry.root, owner: entry.owner };
  });
}

export function decodeSystemdEnvironmentValue(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) {
    throw new Error('Systemd environment values must be single-line strings');
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    const decoded = JSON.parse(value);
    if (typeof decoded !== 'string') throw new Error('Quoted systemd environment value must contain a string');
    return decoded;
  }
  return value;
}

export function encodeSystemdEnvironmentValue(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) {
    throw new Error('Systemd environment values must be single-line strings');
  }

  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function updateProjectEnvironmentRootMap(content, roots) {
  if (typeof content !== 'string') throw new TypeError('Environment file content must be a string');
  const normalizedRoots = validateProjectEnvironmentRoots(roots);
  const json = JSON.stringify(normalizedRoots);
  const replacement = `${PROJECT_ENV_ROOTS_KEY}=${encodeSystemdEnvironmentValue(json)}`;
  const hadTrailingNewline = content.endsWith('\n');
  const lines = content.split(/\r?\n/).filter((line) => !line.startsWith(`${PROJECT_ENV_ROOTS_KEY}=`));
  while (lines.length && lines.at(-1) === '') lines.pop();
  lines.push(replacement);
  return lines.join('\n') + (hadTrailingNewline ? '\n' : '');
}

export async function updateProjectEnvironmentRootMapFile(filePath, roots) {
  const metadata = await fs.lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Environment path is not a regular file: ${filePath}`);

  const original = await fs.readFile(filePath, 'utf8');
  const updated = updateProjectEnvironmentRootMap(original, roots);
  if (updated === original) return false;

  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, updated, { flag: 'wx', mode: metadata.mode & 0o777 });
    await fs.chown(temporary, metadata.uid, metadata.gid);
    await fs.chmod(temporary, metadata.mode & 0o7777);
    await fs.rename(temporary, filePath);
    return true;
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  decodeSystemdEnvironmentValue,
  encodeSystemdEnvironmentValue,
  PROJECT_ENV_ROOTS_KEY,
  updateProjectEnvironmentRootMap,
  updateProjectEnvironmentRootMapFile,
  validateProjectEnvironmentRoots,
} from './project-environment-root-config.mjs';

const roots = [
  { root: '/var/lib/vps-mcp/project-environments', owner: 'vps-mcp' },
  { root: '/var/lib/vps-mcp-development/project-environments', owner: 'vps-mcp-development' },
];

let temporaryDirectory;

afterEach(async () => {
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe('project environment root configuration', () => {
  it('validates and preserves the ordered production/development owner map', () => {
    expect(validateProjectEnvironmentRoots(JSON.stringify(roots))).toEqual(roots);
  });

  it.each([
    ['malformed JSON', '{'],
    ['empty list', '[]'],
    ['relative root', [{ root: 'relative', owner: 'vps-mcp' }]],
    ['non-canonical root', [{ root: '/var/lib/../tmp', owner: 'vps-mcp' }]],
    ['trailing slash', [{ root: '/srv/project-environments/', owner: 'vps-mcp' }]],
    ['filesystem root', [{ root: '/', owner: 'vps-mcp' }]],
    ['comma in root', [{ root: '/srv/project,environments', owner: 'vps-mcp' }]],
    ['invalid owner', [{ root: '/srv/project-environments', owner: 'not a user' }]],
    ['duplicate root', [{ root: '/srv/project-environments', owner: 'vps-mcp' }, { root: '/srv/project-environments', owner: 'vps-mcp-development' }]],
    ['duplicate owner', [{ root: '/srv/production', owner: 'vps-mcp' }, { root: '/srv/development', owner: 'vps-mcp' }]],
  ])('rejects %s', (_name, value) => {
    expect(() => validateProjectEnvironmentRoots(value)).toThrow();
  });

  it('encodes JSON as one systemd EnvironmentFile value', () => {
    expect(encodeSystemdEnvironmentValue(JSON.stringify(roots)))
      .toBe('"[{\\"root\\":\\"/var/lib/vps-mcp/project-environments\\",\\"owner\\":\\"vps-mcp\\"},{\\"root\\":\\"/var/lib/vps-mcp-development/project-environments\\",\\"owner\\":\\"vps-mcp-development\\"}]"');
  });

  it('replaces duplicate root-map entries without changing unrelated environment values', () => {
    const input = [
      '# preserve comments',
      'NODE_ENV=production',
      'API_TOKEN=keep-this-line',
      `${PROJECT_ENV_ROOTS_KEY}="old"`,
      `${PROJECT_ENV_ROOTS_KEY}="duplicate"`,
      '',
    ].join('\n');

    const updated = updateProjectEnvironmentRootMap(input, roots);
    expect(updated).toContain('# preserve comments');
    expect(updated).toContain('NODE_ENV=production');
    expect(updated).toContain('API_TOKEN=keep-this-line');
    expect(updated.match(new RegExp(`^${PROJECT_ENV_ROOTS_KEY}=.*$`, 'gm'))).toHaveLength(1);
    expect(updateProjectEnvironmentRootMap(updated, roots)).toBe(updated);
  });

  it('writes atomically while preserving environment file ownership and permissions', async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-project-root-config-'));
    const filePath = path.join(temporaryDirectory, 'service.env');
    await fs.writeFile(filePath, 'NODE_ENV=production\n', { mode: 0o640 });
    await fs.chmod(filePath, 0o640);
    const before = await fs.stat(filePath);

    expect(await updateProjectEnvironmentRootMapFile(filePath, roots)).toBe(true);
    expect(await updateProjectEnvironmentRootMapFile(filePath, roots)).toBe(false);

    const after = await fs.stat(filePath);
    expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(await fs.readFile(filePath, 'utf8')).toContain(`${PROJECT_ENV_ROOTS_KEY}=`);
    expect(await fs.readdir(temporaryDirectory)).toEqual(['service.env']);
  });
});

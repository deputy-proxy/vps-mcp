import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isMountpoint, projectRuntimeAclPlan, resolveProjectServicePaths } from './vps-sandbox-quota-helper.mjs';

const repositoryId = 'deputy-proxy-vps-mcp';
const releaseId = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
let root = '';
const previousRoot = process.env.VPS_SANDBOX_PROJECT_ENV_ROOT;
const previousRootsJson = process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON;

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
  if (previousRoot === undefined) delete process.env.VPS_SANDBOX_PROJECT_ENV_ROOT;
  else process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = previousRoot;
  if (previousRootsJson === undefined) delete process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON;
  else process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON = previousRootsJson;
});

describe('isMountpoint', () => {
  it('returns true when mountpoint exits successfully', () => {
    const execute = () => {};
    expect(isMountpoint('/tmp/example', execute)).toBe(true);
  });
  it('treats util-linux exit code 32 as not mounted', () => {
    const execute = () => { const error = new Error('not a mountpoint'); error.status = 32; throw error; };
    expect(isMountpoint('/tmp/example', execute)).toBe(false);
  });
  it('propagates unexpected command failures', () => {
    const execute = () => { const error = new Error('permission denied'); error.status = 1; throw error; };
    expect(() => isMountpoint('/tmp/example', execute)).toThrow('permission denied');
  });
});

describe('canonical project-service mount source resolution', () => {
  it('derives only the release and project-owned data mount paths from stable identities', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-project-mounts-'));
    process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = root;
    const environment = path.join(root, repositoryId);
    const paths = {
      release: path.join(environment, 'releases', releaseId),
      storage: path.join(environment, 'storage'),
      cache: path.join(environment, 'cache'),
      logs: path.join(environment, 'logs'),
    };
    for (const directory of Object.values(paths)) await fs.mkdir(directory, { recursive: true });
    expect(resolveProjectServicePaths(repositoryId, releaseId)).toEqual({ environment, ...paths });
    expect(projectRuntimeAclPlan(repositoryId, releaseId)).toEqual({
      readOnly: [paths.release],
      writable: [paths.storage, paths.cache, paths.logs],
    });
  });

  it('resolves a repository from its matching root in a multi-root configuration', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-project-roots-'));
    const productionRoot = path.join(root, 'production');
    const developmentRoot = path.join(root, 'development');
    process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON = JSON.stringify([
      { root: productionRoot, owner: 'vps-mcp' },
      { root: developmentRoot, owner: 'vps-mcp-development' },
    ]);
    const environment = path.join(developmentRoot, repositoryId);
    const paths = {
      release: path.join(environment, 'releases', releaseId),
      storage: path.join(environment, 'storage'),
      cache: path.join(environment, 'cache'),
      logs: path.join(environment, 'logs'),
    };
    for (const directory of Object.values(paths)) await fs.mkdir(directory, { recursive: true });
    expect(resolveProjectServicePaths(repositoryId, releaseId)).toEqual({ environment, ...paths });
  });

  it('fails closed when a repository exists under more than one approved root', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-project-roots-'));
    const firstRoot = path.join(root, 'first');
    const secondRoot = path.join(root, 'second');
    process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON = JSON.stringify([
      { root: firstRoot, owner: 'vps-mcp' },
      { root: secondRoot, owner: 'vps-mcp-development' },
    ]);
    for (const base of [firstRoot, secondRoot]) {
      const environment = path.join(base, repositoryId);
      for (const directory of ['releases/' + releaseId, 'storage', 'cache', 'logs']) {
        await fs.mkdir(path.join(environment, directory), { recursive: true });
      }
    }
    expect(() => resolveProjectServicePaths(repositoryId, releaseId)).toThrow('multiple approved roots');
  });

  it('rejects malformed or duplicate root configuration', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-project-roots-'));
    process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON = JSON.stringify([
      { root, owner: 'vps-mcp' }, { root, owner: 'vps-mcp-development' },
    ]);
    expect(() => resolveProjectServicePaths(repositoryId, releaseId)).toThrow('must be unique');
  });

  it('rejects unsafe repository and release identities', () => {
    expect(() => resolveProjectServicePaths('../etc', releaseId)).toThrow('repository ID');
    expect(() => resolveProjectServicePaths(repositoryId, '../release')).toThrow('release identity');
  });

  it('rejects symlinked environment mount sources', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-project-mounts-'));
    process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = root;
    const environment = path.join(root, repositoryId);
    await fs.mkdir(path.join(environment, 'releases'), { recursive: true });
    await fs.mkdir(path.join(environment, 'storage'));
    await fs.mkdir(path.join(environment, 'cache'));
    await fs.mkdir(path.join(environment, 'logs'));
    await fs.mkdir(path.join(root, 'outside'));
    await fs.symlink(path.join(root, 'outside'), path.join(environment, 'releases', releaseId));
    expect(() => resolveProjectServicePaths(repositoryId, releaseId)).toThrow('canonical real directory');
  });
});

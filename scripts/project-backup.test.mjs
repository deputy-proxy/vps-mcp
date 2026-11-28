import { describe, expect, it } from 'vitest';
import { createProjectBackupManifest, decodeProjectBackupKey, decryptProjectBackupArtifact, encryptProjectBackupArtifact, replaceProjectStorageContents, validateProjectBackupManifest } from './project-backup.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const keyText = Buffer.alloc(32, 7).toString('base64url');
const key = decodeProjectBackupKey(keyText);
const identity = {
  backupId: '134e5321-b4d7-4d4f-be92-ce56a984adaa',
  repositoryId: 'deputy-proxy-vps-mcp',
  environmentId: '234e5321-b4d7-4d4f-be92-ce56a984adaa',
  profileId: 'laravel-php', profileVersion: 4, enabledDependencies: ['mysql', 'redis'],
};

describe('encrypted project backup contract', () => {
  it('round-trips database and storage artifacts with authenticated encryption', () => {
    for (const kind of ['database', 'storage']) {
      const plain = Buffer.from(`project ${kind} payload`);
      const encrypted = encryptProjectBackupArtifact(plain, key, identity, kind);
      expect(encrypted.ciphertext.equals(plain)).toBe(false);
      expect(decryptProjectBackupArtifact(encrypted.ciphertext, encrypted.metadata, key, identity, kind)).toEqual(plain);
    }
  });

  it('creates and verifies a signed identity-bound manifest', () => {
    const database = encryptProjectBackupArtifact(Buffer.from('sql'), key, identity, 'database');
    const storage = encryptProjectBackupArtifact(Buffer.from('tar'), key, identity, 'storage');
    const manifest = createProjectBackupManifest({ ...identity, artifacts: { database: database.metadata, storage: storage.metadata } }, key);
    expect(validateProjectBackupManifest(manifest, identity, key)).toMatchObject(identity);
    expect(() => validateProjectBackupManifest(manifest, { ...identity, repositoryId: 'another-repo' }, key)).toThrow('IDENTITY_MISMATCH');
    expect(() => validateProjectBackupManifest({ ...manifest, profileVersion: 3 }, identity, key)).toThrow('IDENTITY_MISMATCH');
    expect(() => validateProjectBackupManifest({ ...manifest, artifacts: { ...manifest.artifacts, database: { ...manifest.artifacts.database, sha256: 'b'.repeat(64) } } }, identity, key)).toThrow('authentication failed');
  });

  it('rejects tampered ciphertext, wrong keys and invalid key encodings', () => {
    const encrypted = encryptProjectBackupArtifact(Buffer.from('sensitive database'), key, identity, 'database');
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[0] ^= 1;
    expect(() => decryptProjectBackupArtifact(tampered, encrypted.metadata, key, identity, 'database')).toThrow('checksum');
    expect(() => decryptProjectBackupArtifact(encrypted.ciphertext, encrypted.metadata, Buffer.alloc(32, 8), identity, 'database')).toThrow();
    expect(() => decodeProjectBackupKey('not-a-key')).toThrow('backup key is invalid');
  });
});


describe('project storage restore transaction', () => {
  it('can roll back a replaced storage tree before commit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-mcp-backup-restore-'));
    try {
      const storage = path.join(root, 'storage');
      const incoming = path.join(root, 'incoming');
      const backups = path.join(root, 'backups');
      await Promise.all([fs.mkdir(storage), fs.mkdir(incoming), fs.mkdir(backups)]);
      await fs.writeFile(path.join(storage, 'old.txt'), 'old-data');
      await fs.writeFile(path.join(incoming, 'new.txt'), 'new-data');
      const storageInode = (await fs.stat(storage)).ino;
      const restoreDirectory = path.join(storage, '.restore-storage-test');
      await fs.rename(incoming, restoreDirectory);
      const transaction = await replaceProjectStorageContents(storage, restoreDirectory, backups, identity.backupId);
      expect(await fs.readFile(path.join(storage, 'new.txt'), 'utf8')).toBe('new-data');
      expect(await fs.readdir(storage)).toEqual(['new.txt']);
      expect((await fs.stat(storage)).ino).toBe(storageInode);
      await transaction.rollback();
      expect(await fs.readFile(path.join(storage, 'old.txt'), 'utf8')).toBe('old-data');
      expect(await fs.readdir(storage)).toEqual(['old.txt']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('commits the replacement and removes the previous storage contents', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-mcp-backup-commit-'));
    try {
      const storage = path.join(root, 'storage');
      const incoming = path.join(root, 'incoming');
      const backups = path.join(root, 'backups');
      await Promise.all([fs.mkdir(storage), fs.mkdir(incoming), fs.mkdir(backups)]);
      await fs.writeFile(path.join(storage, 'old.txt'), 'old-data');
      await fs.writeFile(path.join(incoming, 'new.txt'), 'new-data');
      const restoreDirectory = path.join(storage, '.restore-storage-test');
      await fs.rename(incoming, restoreDirectory);
      const transaction = await replaceProjectStorageContents(storage, restoreDirectory, backups, identity.backupId);
      await transaction.commit();
      expect(await fs.readdir(storage)).toEqual(['new.txt']);
      expect(await fs.readdir(backups)).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const MAX_BACKUP_ARTIFACT_BYTES = 256 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

function assert(condition, message) { if (!condition) throw new Error(message); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

export function decodeProjectBackupKey(value) {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value), 'Project backup key is invalid');
  const key = Buffer.from(value, 'base64url');
  assert(key.length === 32 && key.toString('base64url') === value, 'Project backup key must contain exactly 256 bits');
  return key;
}

function artifactAad(identity, kind) {
  return Buffer.from(`${identity.repositoryId}:${identity.environmentId}:${identity.backupId}:${kind}`, 'utf8');
}

export function encryptProjectBackupArtifact(plaintext, key, identity, kind) {
  assert(Buffer.isBuffer(plaintext) && plaintext.length <= MAX_BACKUP_ARTIFACT_BYTES, 'Backup artifact exceeds the 256 MiB safety limit');
  assert(Buffer.isBuffer(key) && key.length === 32, 'Project backup encryption key is invalid');
  assert(UUID.test(identity?.backupId ?? '') && UUID.test(identity?.environmentId ?? '') && typeof identity?.repositoryId === 'string', 'Backup identity is invalid');
  assert(kind === 'database' || kind === 'storage', 'Unsupported project backup artifact');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(artifactAad(identity, kind));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    metadata: {
      file: kind === 'database' ? 'database.sql.enc' : 'storage.tar.gz.enc',
      sha256: sha256(ciphertext),
      plaintextSha256: sha256(plaintext),
      plaintextBytes: plaintext.length,
      encryptedBytes: ciphertext.length,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    },
  };
}

export function decryptProjectBackupArtifact(ciphertext, metadata, key, identity, kind) {
  assert(Buffer.isBuffer(ciphertext) && ciphertext.length <= MAX_BACKUP_ARTIFACT_BYTES, 'Encrypted backup artifact exceeds the 256 MiB safety limit');
  assert(Buffer.isBuffer(key) && key.length === 32, 'Project backup encryption key is invalid');
  assert(metadata && typeof metadata === 'object' && SHA256.test(metadata.sha256 ?? '') && sha256(ciphertext) === metadata.sha256, 'Backup artifact checksum does not match its manifest');
  assert(Number.isSafeInteger(metadata.plaintextBytes) && metadata.plaintextBytes >= 0 && metadata.plaintextBytes <= MAX_BACKUP_ARTIFACT_BYTES, 'Backup plaintext size is invalid');
  assert(Number.isSafeInteger(metadata.encryptedBytes) && metadata.encryptedBytes === ciphertext.length, 'Backup ciphertext size does not match its manifest');
  const nonce = Buffer.from(metadata.nonce ?? '', 'base64');
  const tag = Buffer.from(metadata.tag ?? '', 'base64');
  assert(nonce.length === 12 && tag.length === 16, 'Backup encryption metadata is invalid');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(artifactAad(identity, kind));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert(plaintext.length === metadata.plaintextBytes && sha256(plaintext) === metadata.plaintextSha256, 'Decrypted backup artifact failed integrity validation');
  return plaintext;
}

function manifestPayload(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    backupId: manifest.backupId,
    repositoryId: manifest.repositoryId,
    environmentId: manifest.environmentId,
    profileId: manifest.profileId,
    profileVersion: manifest.profileVersion,
    enabledDependencies: manifest.enabledDependencies,
    createdAt: manifest.createdAt,
    encryption: manifest.encryption,
    artifacts: manifest.artifacts,
  };
}

export function createProjectBackupManifest(input, key) {
  assert(Buffer.isBuffer(key) && key.length === 32, 'Project backup encryption key is invalid');
  assert(UUID.test(input.backupId ?? '') && UUID.test(input.environmentId ?? ''), 'Backup identity is invalid');
  assert(typeof input.repositoryId === 'string' && /^[a-z0-9][a-z0-9._-]{1,199}$/i.test(input.repositoryId), 'Backup repository identity is invalid');
  assert(typeof input.profileId === 'string' && Number.isSafeInteger(input.profileVersion) && input.profileVersion >= 1, 'Backup profile identity is invalid');
  assert(Array.isArray(input.enabledDependencies) && input.enabledDependencies.includes('mysql') && input.enabledDependencies.every((name) => ['mysql', 'redis'].includes(name)), 'Backup enabled dependency selection is invalid');
  assert(input.artifacts && input.artifacts.database && input.artifacts.storage, 'Database and storage backup artifacts are required');
  const manifest = {
    schemaVersion: 1,
    backupId: input.backupId,
    repositoryId: input.repositoryId,
    environmentId: input.environmentId,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    enabledDependencies: [...input.enabledDependencies],
    createdAt: input.createdAt ?? new Date().toISOString(),
    encryption: { algorithm: 'AES-256-GCM', keyVersion: 1 },
    artifacts: { database: input.artifacts.database, storage: input.artifacts.storage },
  };
  manifest.manifestHmac = createHmac('sha256', key).update(JSON.stringify(manifestPayload(manifest))).digest('hex');
  return manifest;
}

export function validateProjectBackupManifest(manifest, expected, key) {
  assert(manifest && typeof manifest === 'object' && manifest.schemaVersion === 1, 'Unsupported project backup manifest');
  assert(UUID.test(manifest.backupId ?? '') && UUID.test(manifest.environmentId ?? ''), 'Project backup manifest identity is invalid');
  assert(manifest.backupId === expected.backupId && manifest.repositoryId === expected.repositoryId
    && manifest.environmentId === expected.environmentId && manifest.profileId === expected.profileId
    && manifest.profileVersion === expected.profileVersion
    && JSON.stringify(manifest.enabledDependencies) === JSON.stringify(expected.enabledDependencies), 'PROJECT_BACKUP_IDENTITY_MISMATCH: backup does not belong to this exact repository environment and profile version');
  assert(manifest.encryption?.algorithm === 'AES-256-GCM' && manifest.encryption.keyVersion === 1, 'Unsupported project backup encryption format');
  assert(typeof manifest.createdAt === 'string' && !Number.isNaN(Date.parse(manifest.createdAt)), 'Project backup timestamp is invalid');
  assert(Array.isArray(manifest.enabledDependencies) && manifest.enabledDependencies.includes('mysql')
    && manifest.enabledDependencies.every((name) => ['mysql', 'redis'].includes(name)), 'Project backup enabled dependency manifest is invalid');
  for (const kind of ['database', 'storage']) {
    const item = manifest.artifacts?.[kind];
    const expectedFile = kind === 'database' ? 'database.sql.enc' : 'storage.tar.gz.enc';
    assert(item && item.file === expectedFile && SHA256.test(item.sha256 ?? '') && SHA256.test(item.plaintextSha256 ?? '')
      && Number.isSafeInteger(item.plaintextBytes) && Number.isSafeInteger(item.encryptedBytes)
      && typeof item.nonce === 'string' && typeof item.tag === 'string', `Project backup ${kind} artifact metadata is invalid`);
  }
  const expectedHmac = createHmac('sha256', key).update(JSON.stringify(manifestPayload(manifest))).digest();
  const actualHmac = Buffer.from(manifest.manifestHmac ?? '', 'hex');
  assert(actualHmac.length === expectedHmac.length && timingSafeEqual(actualHmac, expectedHmac), 'PROJECT_BACKUP_MANIFEST_INVALID: backup manifest authentication failed');
  return { backupId: manifest.backupId, repositoryId: manifest.repositoryId, environmentId: manifest.environmentId, profileId: manifest.profileId, profileVersion: manifest.profileVersion, enabledDependencies: manifest.enabledDependencies, createdAt: manifest.createdAt };
}


export async function replaceProjectStorageContents(storagePath, restorePath, backupDirectory, backupId) {
  const canonicalStorage = path.resolve(storagePath);
  const canonicalRestore = path.resolve(restorePath);
  if (path.dirname(canonicalRestore) !== canonicalStorage || !path.basename(canonicalRestore).startsWith('.restore-storage-')) {
    throw new Error('Restore staging directory must be a direct child of the canonical project storage mount');
  }
  const oldPath = path.join(backupDirectory, '.old-storage-' + backupId);
  await fs.mkdir(oldPath, { mode: 0o700 });
  const move = async (source, destination) => await fs.rename(source, destination);
  const restoreName = path.basename(canonicalRestore);
  const current = (await fs.readdir(storagePath)).filter((name) => name !== restoreName);
  try {
    for (const name of current) await move(path.join(storagePath, name), path.join(oldPath, name));
    const incoming = await fs.readdir(restorePath);
    for (const name of incoming) await move(path.join(restorePath, name), path.join(storagePath, name));
    await fs.rmdir(restorePath);
  } catch (error) {
    for (const name of await fs.readdir(storagePath)) await fs.rm(path.join(storagePath, name), { recursive: true, force: true });
    for (const name of await fs.readdir(oldPath)) await move(path.join(oldPath, name), path.join(storagePath, name));
    await fs.rm(oldPath, { recursive: true, force: true });
    throw error;
  }
  return {
    commit: async () => await fs.rm(oldPath, { recursive: true, force: true }),
    rollback: async () => {
      for (const name of await fs.readdir(storagePath)) await fs.rm(path.join(storagePath, name), { recursive: true, force: true });
      for (const name of await fs.readdir(oldPath)) await move(path.join(oldPath, name), path.join(storagePath, name));
      await fs.rm(oldPath, { recursive: true, force: true });
    },
  };
}

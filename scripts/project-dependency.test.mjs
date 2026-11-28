import { describe, expect, it } from 'vitest';
import { APPROVED_PROJECT_DEPENDENCY_IMAGES, APPROVED_PROJECT_SERVICE_IMAGES, DEPENDENCIES, buildProjectDependencyCreateArgs, dependencyHealthCommand, dependencyStagingPaths, projectDependencyWorkloadId, validateProjectDependencyDeclaration, validateProjectDependencyInspection } from './project-dependency.mjs';
import { projectPodName } from './project-pod.mjs';

const repositoryId = 'deputy-proxy-vps-mcp-01d9433d21';
const environmentId = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
const mysqlId = projectDependencyWorkloadId(environmentId, 'mysql');
const image = `dhi.io/mysql@sha256:${'a'.repeat(64)}`;
const resources = { cpuMilli: 500, memoryMiB: 768, pids: 128, diskMiB: 10240 };
const reservationResources = { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 };

describe('project dependency runtime contract', () => {
  it('separates container-mounted secret files from host-only initialization credentials', () => {
    expect(DEPENDENCIES.mysql.secretFiles).toEqual(['mysql-root-password', 'mysql-root.cnf']);
    expect(DEPENDENCIES.mysql.hostSecretFiles).toContain('initialize.sql');
    expect(DEPENDENCIES.mysql.hostSecretFiles).toEqual(['initialize.sql']);
    expect(DEPENDENCIES.redis.secretFiles).toEqual(['redis-users.acl', 'redis.conf']);
    expect(DEPENDENCIES.redis.hostSecretFiles).toEqual(['redis-app-password']);
  });

  it('requires each dependency workload to match the registered application profile manifest', () => {
    const parent = {
      id: environmentId, environmentId, workloadType: 'project-service', repositoryId, status: 'created',
      reservationResources,
      dependencies: [{ name: 'mysql', image, resources }],
    };
    expect(validateProjectDependencyDeclaration(parent, { repositoryId, environmentId, dependency: 'mysql', image, resources, reservationResources })).toBe(true);
    expect(() => validateProjectDependencyDeclaration(parent, { repositoryId, environmentId, dependency: 'redis', image, resources, reservationResources })).toThrow('not declared');
    expect(() => validateProjectDependencyDeclaration(parent, { repositoryId: 'another-repo', environmentId, dependency: 'mysql', image, resources, reservationResources })).toThrow('registered project-service');
    expect(() => validateProjectDependencyDeclaration({ ...parent, status: 'removed' }, { repositoryId, environmentId, dependency: 'mysql', image, resources, reservationResources })).toThrow('registered project-service');
    expect(() => validateProjectDependencyDeclaration(parent, { repositoryId, environmentId, dependency: 'mysql', image, resources: { ...resources, cpuMilli: 100 }, reservationResources })).toThrow('does not match');
  });

  it('derives deterministic, distinct dependency workload identities', () => {
    expect(projectDependencyWorkloadId(environmentId, 'mysql')).toBe(mysqlId);
    expect(projectDependencyWorkloadId(environmentId, 'mysql')).not.toBe(projectDependencyWorkloadId(environmentId, 'redis'));
    expect(() => projectDependencyWorkloadId('bad', 'mysql')).toThrow('Invalid project environment identity');
  });

  it('derives canonical broker staging paths without exposing secret values', () => {
    expect(dependencyStagingPaths(repositoryId, mysqlId)).toMatchObject({
      data: `/var/lib/vps-sandbox-mounts/projects/${repositoryId}/${mysqlId}/dependency-data`,
      secrets: `/var/lib/vps-sandbox-mounts/projects/${repositoryId}/${mysqlId}/secrets`,
    });
    expect(() => dependencyStagingPaths('../escape', mysqlId)).toThrow('Invalid project dependency repository identity');
  });

  it('builds a hardened MySQL container inside only its repository pod', () => {
    const mounts = dependencyStagingPaths(repositoryId, mysqlId);
    const args = buildProjectDependencyCreateArgs({ workloadId: mysqlId, repositoryId, environmentId, dependency: 'mysql', image, resources, reservationResources, mounts, podName: projectPodName(repositoryId) });
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
    expect(args).toContain('--pod');
    expect(args).not.toContain('--publish');
    expect(args).not.toContain('--network=host');
    expect(args).toContain('MYSQL_ROOT_PASSWORD_FILE=/run/secrets/mysql-root-password');
    expect(args).toContain('mysqld');
    expect(args).toContain(`type=bind,src=${mounts.data},dst=/var/lib/mysql,rw,nosuid,nodev`);
    expect(args).toContain(`type=bind,src=${mounts.secrets}/mysql-root-password,dst=/run/secrets/mysql-root-password,ro,nosuid,nodev`);
    expect(args).toContain(`type=bind,src=${mounts.secrets}/mysql-root.cnf,dst=/run/secrets/mysql-root.cnf,ro,nosuid,nodev`);
  });

  it('pins approved MySQL 8 and Redis 8 images and builds Redis as ephemeral authenticated cache', () => {
    expect(APPROVED_PROJECT_SERVICE_IMAGES).toEqual(['ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:10a7f5152d0bea6be3bde3ea3c6697154f20245128372833629a6d547e298b72']);
    expect(APPROVED_PROJECT_DEPENDENCY_IMAGES).toEqual([
      'dhi.io/mysql@sha256:37115bb21c603311e755d91efaea55beb2eaa3971452687c7098620d9e199fe0',
      'dhi.io/redis@sha256:98143a1ca80a66cd13fe819322c92c23d900c275fe63f7c15d74287a8e7b2a61',
    ]);
    const redisId = projectDependencyWorkloadId(environmentId, 'redis');
    const mounts = dependencyStagingPaths(repositoryId, redisId);
    const args = buildProjectDependencyCreateArgs({
      workloadId: redisId, repositoryId, environmentId, dependency: 'redis', image: APPROVED_PROJECT_DEPENDENCY_IMAGES[1],
      resources: { cpuMilli: 200, memoryMiB: 256, pids: 64, diskMiB: 1024 },
      reservationResources, mounts, podName: projectPodName(repositoryId),
    });
    expect(args).toContain('--tmpfs');
    expect(args).toContain('/data:rw,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700');
    expect(args).toContain('redis-server');
    expect(args).toContain('/run/secrets/redis.conf');
    expect(args).toContain(`type=bind,src=${mounts.secrets}/redis-users.acl,dst=/run/secrets/redis-users.acl,ro,nosuid,nodev`);
    expect(args).toContain(`type=bind,src=${mounts.secrets}/redis.conf,dst=/run/secrets/redis.conf,ro,nosuid,nodev`);
    expect(args).not.toContain('--publish');
    expect(args).not.toContain('--network=host');
    expect(args).not.toContain('--user');
  });

  it('fails closed for unpinned images, wrong mounts, wrong pod and over-reservation', () => {
    const mounts = dependencyStagingPaths(repositoryId, mysqlId);
    const base = { workloadId: mysqlId, repositoryId, environmentId, dependency: 'mysql', image, resources, reservationResources, mounts, podName: projectPodName(repositoryId) };
    expect(() => buildProjectDependencyCreateArgs({ ...base, image: 'mysql:8' })).toThrow('immutable sha256 digest');
    expect(() => buildProjectDependencyCreateArgs({ ...base, mounts: { ...mounts, data: '/tmp/data' } })).toThrow('canonical broker staging paths');
    expect(() => buildProjectDependencyCreateArgs({ ...base, podName: 'other-pod' })).toThrow('repository-private pod');
    expect(() => buildProjectDependencyCreateArgs({ ...base, resources: { ...resources, cpuMilli: 1300 } })).toThrow('exceeds the aggregate');
  });

  it('uses authenticated health probes and rejects mismatched runtime identity or isolation', () => {
    expect(dependencyHealthCommand('mysql')).toContain('--defaults-extra-file=/run/secrets/mysql-root.cnf');
    expect(dependencyHealthCommand('redis')).toEqual(['redis-cli']);
    const podId = 'a'.repeat(64), runtimeId = 'b'.repeat(64), infraContainerId = 'c'.repeat(64);
    const valid = { Id: runtimeId, Pod: podId, State: { Status: 'running' }, Config: { Image: 'dhi.io/mysql@sha256:' + 'a'.repeat(64), User: '65532:65532', Labels: {
      'io.cr8or.vps-mcp.workload': mysqlId, 'io.cr8or.vps-mcp.type': 'project-dependency',
      'io.cr8or.vps-mcp.repository': repositoryId, 'io.cr8or.vps-mcp.environment': environmentId, 'io.cr8or.vps-mcp.dependency': 'mysql', 'io.cr8or.vps-mcp.image-digest': 'sha256:' + 'a'.repeat(64),
    } }, HostConfig: { NetworkMode: `container:${infraContainerId}`, ReadonlyRootfs: true, RestartPolicy: { Name: 'no' }, SecurityOpt: ['no-new-privileges', 'seccomp=/usr/share/containers/seccomp.json'], CapDrop: ['ALL'], PortBindings: {} }, Mounts: [
      { Type: 'bind', Source: `${dependencyStagingPaths(repositoryId, mysqlId).data}`, Destination: '/var/lib/mysql', RW: true },
      { Type: 'bind', Source: `${dependencyStagingPaths(repositoryId, mysqlId).secrets}/mysql-root-password`, Destination: '/run/secrets/mysql-root-password', RW: false },
      { Type: 'bind', Source: `${dependencyStagingPaths(repositoryId, mysqlId).secrets}/mysql-root.cnf`, Destination: '/run/secrets/mysql-root.cnf', RW: false },
      { Type: 'tmpfs', Source: 'tmpfs', Destination: '/tmp', RW: true },
      { Type: 'tmpfs', Source: 'tmpfs', Destination: '/run/mysqld', RW: true },
    ] };
    const expected = { runtimeId, workloadId: mysqlId, repositoryId, environmentId, dependency: 'mysql', image: 'dhi.io/mysql@sha256:' + 'a'.repeat(64), podId, infraContainerId, mounts: dependencyStagingPaths(repositoryId, mysqlId) };
    expect(validateProjectDependencyInspection(valid, expected).state).toBe('running');
    expect(() => validateProjectDependencyInspection({ ...valid, HostConfig: { ...valid.HostConfig, NetworkMode: 'host' } }, expected)).toThrow('isolated project pod');
    expect(() => validateProjectDependencyInspection({ ...valid, HostConfig: { ...valid.HostConfig, ReadonlyRootfs: false } }, expected)).toThrow('read-only');
    expect(() => validateProjectDependencyInspection({ ...valid, Config: { ...valid.Config, User: '0:0' } }, expected)).toThrow('non-root image user');
    expect(() => validateProjectDependencyInspection({ ...valid, Mounts: [...valid.Mounts, { Type: 'bind', Source: '/etc/shadow', Destination: '/run/shadow', RW: false }] }, expected)).toThrow('unexpected host bind mount');
  });
});

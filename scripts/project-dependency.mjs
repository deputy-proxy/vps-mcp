import { createHash } from 'node:crypto';
import path from 'node:path';
import { projectPodName, buildProjectPodMemberArgs } from './project-pod.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9._-]{1,199}$/i;
const IMAGE = /^[a-z0-9][a-z0-9._/:+-]{0,180}@sha256:[a-f0-9]{64}$/i;
export const APPROVED_PROJECT_SERVICE_IMAGES = Object.freeze([
  'ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:10a7f5152d0bea6be3bde3ea3c6697154f20245128372833629a6d547e298b72',
]);
export const APPROVED_PROJECT_DEPENDENCY_IMAGES = Object.freeze([
  'dhi.io/mysql@sha256:37115bb21c603311e755d91efaea55beb2eaa3971452687c7098620d9e199fe0',
  'dhi.io/redis@sha256:98143a1ca80a66cd13fe819322c92c23d900c275fe63f7c15d74287a8e7b2a61',
]);
export const DEPENDENCIES = Object.freeze({
  mysql: { target: '/var/lib/mysql', secretFiles: ['mysql-root-password', 'mysql-root.cnf'], hostSecretFiles: ['initialize.sql'], command: ['mysqld'], port: 3306 },
  redis: { target: '/data', secretFiles: ['redis-users.acl', 'redis.conf'], hostSecretFiles: ['redis-app-password'], command: ['redis-server', '/run/secrets/redis.conf'], port: 6379 },
});

function assert(condition, message) { if (!condition) throw new Error(message); }
function validateResources(resources) {
  for (const key of ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB']) assert(Number.isSafeInteger(resources?.[key]) && resources[key] > 0, `Dependency ${key} reservation is required`);
  assert(resources.cpuMilli >= 100 && resources.cpuMilli <= 2000, 'Dependency CPU reservation is outside the supported range');
  assert(resources.memoryMiB >= 128 && resources.memoryMiB <= 4096, 'Dependency memory reservation is outside the supported range');
  assert(resources.pids >= 32 && resources.pids <= 512, 'Dependency PID reservation is outside the supported range');
  assert(resources.diskMiB >= 128 && resources.diskMiB <= 102400, 'Dependency disk reservation is outside the supported range');
}

export function projectDependencyWorkloadId(environmentId, dependency) {
  assert(UUID.test(environmentId), 'Invalid project environment identity');
  assert(Object.hasOwn(DEPENDENCIES, dependency), 'Unsupported project dependency');
  const hash = createHash('sha256').update(`${environmentId}:${dependency}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function validateProjectDependencyDeclaration(parent, request) {
  assert(parent?.workloadType === 'project-service' && parent.id === request.environmentId
    && parent.environmentId === request.environmentId && parent.repositoryId === request.repositoryId
    && parent.status !== 'removed', 'Project dependency must belong to an active registered project-service environment');
  assert(Array.isArray(parent.dependencies), 'Project-service record is missing its dependency manifest');
  const declared = parent.dependencies.find((item) => item.name === request.dependency);
  assert(declared && declared.image === request.image, 'Project dependency image is not declared by the registered service profile');
  for (const key of ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB']) {
    assert(declared.resources?.[key] === request.resources?.[key], `Project dependency ${key} does not match the registered service profile`);
    assert(parent.reservationResources?.[key] === request.reservationResources?.[key], `Project dependency aggregate ${key} does not match the registered service profile`);
  }
  return true;
}

export function dependencyStagingPaths(repositoryId, workloadId) {
  assert(REPOSITORY_ID.test(repositoryId), 'Invalid project dependency repository identity');
  assert(UUID.test(workloadId), 'Invalid project dependency workload identity');
  const base = `/var/lib/vps-sandbox-mounts/projects/${repositoryId}/${workloadId}`;
  return {
    data: `${base}/dependency-data`,
    secrets: `${base}/secrets`,
    rootPassword: `${base}/secrets/mysql-root-password`,
    rootClientConfig: `${base}/secrets/mysql-root.cnf`,
    redisAcl: `${base}/secrets/redis-users.acl`,
  };
}

export function buildProjectDependencyCreateArgs(input) {
  assert(input && typeof input === 'object', 'Dependency workload input is required');
  const { workloadId, repositoryId, environmentId, dependency, image, resources, reservationResources, mounts, restartPolicy = 'no' } = input;
  assert(UUID.test(workloadId), 'Invalid project dependency workload identity');
  assert(REPOSITORY_ID.test(repositoryId), 'Invalid project dependency repository identity');
  assert(UUID.test(environmentId), 'Invalid project dependency environment identity');
  assert(Object.hasOwn(DEPENDENCIES, dependency), 'Unsupported project dependency');
  assert(IMAGE.test(image), 'Dependency image must be pinned by an immutable sha256 digest');
  validateResources(resources);
  validateResources(reservationResources);
  for (const key of ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB']) assert(resources[key] <= reservationResources[key], `Dependency ${key} exceeds the aggregate project reservation`);
  assert(restartPolicy === 'no', 'Project dependencies must use restart=no so ordered recovery controls startup');
  const expected = dependencyStagingPaths(repositoryId, workloadId);
  assert(mounts?.data === expected.data && mounts?.secrets === expected.secrets, 'Dependency mounts do not match their canonical broker staging paths');
  assert(input.podName === projectPodName(repositoryId), 'Dependency must join its repository-private pod');
  const spec = DEPENDENCIES[dependency];
  const args = [
    'create', '--pull=never', '--name', `vps-wl-${workloadId}`,
    '--label', `io.cr8or.vps-mcp.workload=${workloadId}`,
    '--label', 'io.cr8or.vps-mcp.type=project-dependency',
    '--label', `io.cr8or.vps-mcp.repository=${repositoryId}`,
    '--label', `io.cr8or.vps-mcp.environment=${environmentId}`,
    '--label', `io.cr8or.vps-mcp.dependency=${dependency}`,
    '--label', `io.cr8or.vps-mcp.pod=${input.podName}`,
    '--label', `io.cr8or.vps-mcp.image-digest=${image.slice(image.lastIndexOf('@') + 1)}`,
    '--restart', restartPolicy,
    ...buildProjectPodMemberArgs(input.podName),
    '--http-proxy=false', '--read-only', '--cap-drop=ALL',
    '--userns=keep-id:uid=65532,gid=65532',
    '--security-opt=no-new-privileges', '--security-opt=seccomp=/usr/share/containers/seccomp.json',
    '--pids-limit', String(resources.pids), '--memory', `${resources.memoryMiB}m`, `--memory-swap=${resources.memoryMiB}m`,
    '--cpus', String(resources.cpuMilli / 1000), '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
    ...(dependency === 'mysql' ? ['--tmpfs', '/run/mysqld:rw,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700'] : []),
    ...(dependency === 'mysql' ? ['--mount', `type=bind,src=${mounts.data},dst=${spec.target},rw,nosuid,nodev`] : ['--tmpfs', '/data:rw,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700']),
    ...(DEPENDENCIES[dependency].secretFiles.flatMap((file) => [
      '--mount', `type=bind,src=${path.join(mounts.secrets, file)},dst=/run/secrets/${file},ro,nosuid,nodev`,
    ])),
    ...(dependency === 'mysql' ? ['--env', 'MYSQL_ROOT_PASSWORD_FILE=/run/secrets/mysql-root-password'] : []),
    image,
    ...(input.command ?? spec.command),
  ];
  return args;
}

export function validateProjectDependencyInspection(value, expected) {
  const item = Array.isArray(value) ? value[0] : value;
  assert(item && typeof item === 'object' && !Array.isArray(item), 'Podman returned invalid dependency inspection data');
  assert(item.Id === expected.runtimeId, 'Dependency runtime identity does not match its durable record');
  assert(item.Config?.Image === expected.image && item.Config?.Labels?.['io.cr8or.vps-mcp.image-digest'] === expected.image.slice(expected.image.lastIndexOf('@') + 1), 'Dependency image reference does not match its approved immutable digest');
  assert(String(item.Config?.User ?? '').split(':')[0] === '65532', 'Dependency must run as the approved non-root image user');
  assert(item.Config?.Labels?.['io.cr8or.vps-mcp.workload'] === expected.workloadId, 'Dependency workload label does not match its durable identity');
  assert(item.Config?.Labels?.['io.cr8or.vps-mcp.type'] === 'project-dependency', 'Runtime container is not a project dependency');
  assert(item.Config?.Labels?.['io.cr8or.vps-mcp.repository'] === expected.repositoryId, 'Dependency repository label does not match its durable identity');
  assert(item.Config?.Labels?.['io.cr8or.vps-mcp.environment'] === expected.environmentId, 'Dependency environment label does not match its durable identity');
  assert(item.Config?.Labels?.['io.cr8or.vps-mcp.dependency'] === expected.dependency, 'Dependency name label does not match its durable identity');
  assert(item.Pod === expected.podId, 'Dependency is not a member of its registered project pod');
  assert(item.HostConfig?.NetworkMode === `container:${expected.infraContainerId}`, 'Dependency is not sharing the isolated project pod network namespace');
  assert(item.HostConfig?.ReadonlyRootfs === true && item.HostConfig?.Privileged !== true, 'Dependency root filesystem must be read-only and unprivileged');
  assert(item.HostConfig?.RestartPolicy?.Name === 'no', 'Project dependency restart policy must be no; ordered runtime recovery owns startup');
  assert(item.HostConfig?.NetworkMode !== 'host' && !(item.HostConfig?.PortBindings && Object.values(item.HostConfig.PortBindings).some((ports) => Array.isArray(ports) && ports.length)), 'Dependency must not use host networking or publish ports');
  assert(item.HostConfig?.SecurityOpt?.includes('no-new-privileges'), 'Dependency must enforce no-new-privileges');
  assert(item.HostConfig?.CapDrop?.includes('ALL'), 'Dependency must drop all capabilities');
  assert(expected.mounts?.data && expected.mounts?.secrets && Array.isArray(item.Mounts), 'Dependency inspection is missing its canonical mount contract');
  const secretFiles = expected.dependency === 'mysql' ? ['mysql-root-password', 'mysql-root.cnf'] : ['redis-users.acl', 'redis.conf'];
  const expectedMounts = [
    ...(expected.dependency === 'mysql' ? [{ source: expected.mounts.data, destination: '/var/lib/mysql', readWrite: true }] : []),
    ...secretFiles.map((file) => ({ source: path.join(expected.mounts.secrets, file), destination: `/run/secrets/${file}`, readWrite: false })),
  ];
  const allowedBindDestinations = new Set([...expectedMounts.map((mount) => mount.destination), '/etc/hosts', '/etc/hostname', '/etc/resolv.conf']);
  const allBindMounts = item.Mounts.filter((mount) => mount.Type === 'bind');
  assert(allBindMounts.every((mount) => allowedBindDestinations.has(mount.Destination)), 'Dependency contains an unexpected host bind mount');
  const projectMounts = allBindMounts.filter((mount) => String(mount.Source ?? '').includes('/var/lib/vps-sandbox-mounts/projects/'));
  assert(projectMounts.length === expectedMounts.length, 'Dependency has unexpected project bind mounts');
  for (const mount of expectedMounts) {
    const actual = projectMounts.find((item) => item.Source === mount.source && item.Destination === mount.destination);
    assert(actual && actual.RW === mount.readWrite, 'Dependency project bind mount does not match its canonical read/write contract');
  }
  const tmpfsDestinations = expected.dependency === 'mysql' ? ['/tmp', '/run/mysqld'] : ['/tmp', '/data'];
  for (const destination of tmpfsDestinations) {
    assert(item.Mounts.some((mount) => mount.Type === 'tmpfs' && mount.Destination === destination && mount.RW === true),
      `Dependency is missing its required writable tmpfs mount at ${destination}`);
  }
  return { workloadId: expected.workloadId, repositoryId: expected.repositoryId, dependency: expected.dependency, runtimeId: item.Id, podId: item.Pod, state: item.State?.Status ?? 'unknown' };
}

export function dependencyHealthCommand(dependency) {
  assert(Object.hasOwn(DEPENDENCIES, dependency), 'Unsupported project dependency');
  if (dependency === 'mysql') return ['mysqladmin', '--defaults-extra-file=/run/secrets/mysql-root.cnf', 'ping', '--silent'];
  return ['redis-cli'];
}

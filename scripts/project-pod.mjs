import { createHash } from 'node:crypto';

const REPOSITORY_ID = /^[a-z0-9][a-z0-9._-]{1,199}$/i;
const POD_NAME = /^vps-project-[a-f0-9]{20}$/;
const LABEL_MANAGED = 'io.cr8or.vps-mcp.managed';
const LABEL_REPOSITORY = 'io.cr8or.vps-mcp.repository';
const LABEL_NETWORK_POLICY = 'io.cr8or.vps-mcp.network-policy';

export function projectPodName(repositoryId) {
  if (typeof repositoryId !== 'string' || !REPOSITORY_ID.test(repositoryId)) throw new Error('Invalid project pod repository identity');
  return `vps-project-${createHash('sha256').update(repositoryId).digest('hex').slice(0, 20)}`;
}

export function buildProjectPodCreateArgs(repositoryId) {
  const name = projectPodName(repositoryId);
  return [
    'pod', 'create', '--name', name,
    '--network=none', '--share=net', '--infra=true', '--restart=unless-stopped',
    '--label', `${LABEL_MANAGED}=true`,
    '--label', `${LABEL_REPOSITORY}=${repositoryId}`,
    '--label', `${LABEL_NETWORK_POLICY}=project-private-no-egress`,
    '--cgroup-parent', '/system.slice/vps-sandbox-runtime.service',
  ];
}

function onePod(value) {
  const parsed = Array.isArray(value) ? value[0] : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Podman returned invalid project pod inspection data');
  return parsed;
}

export function validateProjectPodInspection(value, repositoryId) {
  const pod = onePod(value);
  const expectedName = projectPodName(repositoryId);
  if (pod.Name !== expectedName) throw new Error('Project pod name does not match its repository identity');
  if (pod.Labels?.[LABEL_MANAGED] !== 'true' || pod.Labels?.[LABEL_REPOSITORY] !== repositoryId
    || pod.Labels?.[LABEL_NETWORK_POLICY] !== 'project-private-no-egress') {
    throw new Error('Project pod labels do not match the registered project identity and network policy');
  }
  if (pod.CreateInfra !== true || typeof pod.InfraContainerID !== 'string' || !/^[a-f0-9]{12,64}$/i.test(pod.InfraContainerID)) {
    throw new Error('Project pod must have a verified infrastructure container');
  }
  if (!Array.isArray(pod.SharedNamespaces) || pod.SharedNamespaces.length !== 1 || pod.SharedNamespaces[0] !== 'net') {
    throw new Error('Project pod must share only its private network namespace');
  }
  if (pod.InfraConfig?.HostNetwork !== false) throw new Error('Project pod must not use host networking');
  const bindings = pod.InfraConfig?.PortBindings;
  if (bindings && Object.values(bindings).some((items) => Array.isArray(items) && items.length > 0)) {
    throw new Error('Project pod must not publish host ports');
  }
  if (pod.RestartPolicy !== 'unless-stopped') throw new Error('Project pod restart policy does not match the durable environment policy');
  if (pod.CgroupParent !== '/system.slice/vps-sandbox-runtime.service') {
    throw new Error('Project pod cgroup parent does not match the delegated runtime boundary');
  }
  return {
    name: pod.Name,
    id: pod.Id,
    infraContainerId: pod.InfraContainerID,
    state: pod.State,
    sharedNamespaces: [...pod.SharedNamespaces],
    networkMode: 'none',
    networkPolicy: 'project-private-no-egress',
    containers: Array.isArray(pod.Containers) ? pod.Containers.map((container) => ({ id: container.Id ?? container.id, state: container.State ?? container.state })) : [],
  };
}

export function validateProjectPodInfraInspection(value, pod) {
  const infra = onePod(value);
  if (infra.Id !== pod.infraContainerId || infra.Pod !== pod.id || infra.IsInfra !== true) {
    throw new Error('Project pod infrastructure container identity does not match the pod');
  }
  if (infra.HostConfig?.NetworkMode !== 'none') throw new Error('Project pod infrastructure container must use network=none');
  const bindings = infra.HostConfig?.PortBindings;
  if (bindings && Object.values(bindings).some((items) => Array.isArray(items) && items.length > 0)) {
    throw new Error('Project pod infrastructure container must not publish host ports');
  }
  return true;
}

export function validateProjectPodMemberInspection(value, pod) {
  const member = onePod(value);
  if (member.Pod !== pod.id || member.IsInfra === true) throw new Error('Project workload is not a member of its registered project pod');
  if (member.HostConfig?.NetworkMode !== `container:${pod.infraContainerId}`) {
    throw new Error('Project workload is not sharing the isolated project pod network namespace');
  }
  const bindings = member.HostConfig?.PortBindings;
  if (bindings && Object.values(bindings).some((items) => Array.isArray(items) && items.length > 0)) {
    throw new Error('Project workload must not publish host ports');
  }
  return true;
}

export function buildProjectPodMemberArgs(podName) {
  if (typeof podName !== 'string' || !POD_NAME.test(podName)) throw new Error('Invalid project pod name');
  // Deliberately omit --network: Podman then joins the pod's network namespace.
  return ['--pod', podName];
}

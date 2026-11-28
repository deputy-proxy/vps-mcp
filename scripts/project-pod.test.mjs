import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildProjectPodCreateArgs,
  buildProjectPodMemberArgs,
  projectPodName,
  validateProjectPodInspection,
  validateProjectPodInfraInspection,
  validateProjectPodMemberInspection,
} from './project-pod.mjs';

const repositoryId = 'deputy-proxy-vps-mcp-01d9433d21';
const podName = projectPodName(repositoryId);
const pod = {
  Id: 'a'.repeat(64), Name: podName,
  Labels: {
    'io.cr8or.vps-mcp.managed': 'true',
    'io.cr8or.vps-mcp.repository': repositoryId,
    'io.cr8or.vps-mcp.network-policy': 'project-private-no-egress',
  },
  CreateInfra: true, InfraContainerID: 'b'.repeat(64),
  SharedNamespaces: ['net'], CgroupParent: '/system.slice/vps-sandbox-runtime.service',
  InfraConfig: { HostNetwork: false, PortBindings: {} },
  RestartPolicy: 'unless-stopped', State: 'Created', Containers: [],
};

describe('project-private Podman pod contract', () => {
  it('installs the pod policy module alongside the runtime service', () => {
    const installer = fs.readFileSync(path.join(process.cwd(), 'scripts/install-vps-sandbox-runtime.sh'), 'utf8');
    expect(installer).toContain('project-pod.mjs');
    expect(installer).toContain('project-dependency.mjs');
    expect(installer).toContain('project-backup.mjs');
    expect(installer).toContain('${LIBEXEC}/project-pod.mjs');
    expect(installer).toContain('export VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON=');
  });

  it('derives stable, repository-specific pod names', () => {
    expect(projectPodName(repositoryId)).toBe(podName);
    expect(projectPodName(repositoryId)).not.toBe(projectPodName('another-repo-id'));
    expect(() => projectPodName('../escape')).toThrow('Invalid project pod repository identity');
  });

  it('creates an isolated network namespace with no published ports', () => {
    const args = buildProjectPodCreateArgs(repositoryId);
    expect(args).toContain('--network=none');
    expect(args).toContain('--share=net');
    expect(args).toContain('--infra=true');
    expect(args).toContain('--restart=unless-stopped');
    expect(args).toContain('--cgroup-parent');
    expect(args).not.toContain('--publish');
    expect(args).not.toContain('--network=host');
  });

  it('validates pod labels, isolated network namespace and runtime cgroup parent', () => {
    expect(validateProjectPodInspection([pod], repositoryId)).toMatchObject({
      name: podName, id: pod.Id, infraContainerId: pod.InfraContainerID,
      networkMode: 'none', networkPolicy: 'project-private-no-egress', sharedNamespaces: ['net'],
    });
    expect(() => validateProjectPodInspection([{ ...pod, Labels: {} }], repositoryId)).toThrow('labels');
    expect(() => validateProjectPodInspection([{ ...pod, SharedNamespaces: ['net', 'pid'] }], repositoryId)).toThrow('share only');
    expect(() => validateProjectPodInspection([{ ...pod, InfraConfig: { HostNetwork: true } }], repositoryId)).toThrow('host networking');
    expect(() => validateProjectPodInspection([{ ...pod, InfraConfig: { HostNetwork: false, PortBindings: { '3306/tcp': [{ HostPort: '3306' }] } } }], repositoryId)).toThrow('publish host ports');
    expect(() => validateProjectPodInspection([{ ...pod, CgroupParent: '/user.slice' }], repositoryId)).toThrow('cgroup parent');
    expect(() => validateProjectPodInspection([{ ...pod, Containers: undefined }], repositoryId)).toThrow('container inventory');
    expect(() => validateProjectPodInspection([{ ...pod, Containers: [{ id: 'short' }] }], repositoryId)).toThrow('invalid ID');
  });

  it('verifies the infra container has no network or published ports', () => {
    const verifiedPod = validateProjectPodInspection(pod, repositoryId);
    expect(validateProjectPodInfraInspection({
      Id: pod.InfraContainerID, Pod: pod.Id, IsInfra: true,
      HostConfig: { NetworkMode: 'none', PortBindings: {} },
    }, verifiedPod)).toBe(true);
    expect(() => validateProjectPodInfraInspection({
      Id: pod.InfraContainerID, Pod: pod.Id, IsInfra: true,
      HostConfig: { NetworkMode: 'host', PortBindings: {} },
    }, verifiedPod)).toThrow('network=none');
  });

  it('adds project workloads to the pod without overriding its network namespace', () => {
    expect(buildProjectPodMemberArgs(podName)).toEqual(['--pod', podName]);
    expect(() => buildProjectPodMemberArgs('bad-name')).toThrow('Invalid project pod name');
    const verifiedPod = validateProjectPodInspection(pod, repositoryId);
    expect(validateProjectPodMemberInspection({
      Pod: verifiedPod.id, IsInfra: false,
      HostConfig: { NetworkMode: `container:${verifiedPod.infraContainerId}`, PortBindings: {} },
    }, verifiedPod)).toBe(true);
    expect(() => validateProjectPodMemberInspection({
      Pod: verifiedPod.id, IsInfra: false,
      HostConfig: { NetworkMode: 'none', PortBindings: {} },
    }, verifiedPod)).toThrow('sharing the isolated project pod');
  });
});

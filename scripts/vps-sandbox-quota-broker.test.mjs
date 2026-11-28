import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {parseQuotaBrokerRequest} from './vps-sandbox-quota-broker.mjs';
const valid={operation:'apply',repositoryId:'deputy-proxy-vps-mcp',worktreeId:'134e5321-b4d7-4d4f-be92-ce56a984adaa',diskMiB:2048};
describe('workspace quota broker request validation',()=>{
 it('accepts a valid bounded workspace quota request',()=>expect(parseQuotaBrokerRequest(JSON.stringify(valid))).toEqual(valid));
 it('accepts bounded per-workload stage and unstage requests',()=>{
  const request={operation:'stage',repositoryId:valid.repositoryId,worktreeId:valid.worktreeId,workloadId:'234e5321-b4d7-4d4f-be92-ce56a984adaa'};
  expect(parseQuotaBrokerRequest(JSON.stringify(request))).toEqual(request);
  expect(parseQuotaBrokerRequest(JSON.stringify({...request,operation:'unstage'})).operation).toBe('unstage');
 });
 it('accepts project-environment disk quota requests with a stable environment identity',()=>{
  const request={operation:'apply-project',repositoryId:valid.repositoryId,workloadId:'234e5321-b4d7-4d4f-be92-ce56a984adaa',diskMiB:10240};
  expect(parseQuotaBrokerRequest(JSON.stringify(request))).toEqual(request);
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...request,diskMiB:0}))).toThrow('diskMiB');
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...request,environmentId:'../etc'}))).toThrow('Unsupported');
 });
 it('accepts canonical project-service mount staging requests only',()=>{
  const request={operation:'stage-project',repositoryId:valid.repositoryId,workloadId:'234e5321-b4d7-4d4f-be92-ce56a984adaa',releaseId:'334e5321-b4d7-4d4f-be92-ce56a984adaa'};
  expect(parseQuotaBrokerRequest(JSON.stringify(request))).toEqual(request);
  expect(parseQuotaBrokerRequest(JSON.stringify({...request,operation:'unstage-project'})).operation).toBe('unstage-project');
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...request,releaseId:'../release'}))).toThrow('release ID');
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...request,hostPath:'/etc'}))).toThrow('Unsupported');
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...request,worktreeId:'../../etc'}))).toThrow('Unsupported');
 });
 it('accepts project dependency secret preparation without returning secret material',()=>{
  const request={operation:'prepare-dependencies',repositoryId:valid.repositoryId,environmentId:'134e5321-b4d7-4d4f-be92-ce56a984adaa',mysqlEnabled:true,redisEnabled:true};
  expect(parseQuotaBrokerRequest(JSON.stringify(request))).toEqual(request);
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...request,redisEnabled:'true'}))).toThrow('secret preparation');
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...request,secret:'leak'}))).toThrow('Unsupported');
 });
 it('accepts identity-bound backup mount staging operations',()=>{
  const request={operation:'stage-backup',repositoryId:valid.repositoryId,environmentId:'134e5321-b4d7-4d4f-be92-ce56a984adaa',backupId:'234e5321-b4d7-4d4f-be92-ce56a984adaa'};
  expect(parseQuotaBrokerRequest(JSON.stringify(request))).toEqual(request);
  expect(parseQuotaBrokerRequest(JSON.stringify({...request,operation:'unstage-backup'})).operation).toBe('unstage-backup');
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...request,backupId:'bad'}))).toThrow('backup identity');
 });
 it('accepts only named project dependency mount operations',()=>{
  const request={operation:'stage-dependency',repositoryId:valid.repositoryId,workloadId:'234e5321-b4d7-4d4f-be92-ce56a984adaa',dependency:'mysql'};
  expect(parseQuotaBrokerRequest(JSON.stringify(request))).toEqual(request);
  expect(parseQuotaBrokerRequest(JSON.stringify({...request,operation:'unstage-dependency'})).operation).toBe('unstage-dependency');
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...request,dependency:'../../etc'}))).toThrow('dependency name');
 });
 it('rejects unknown operations and extra properties',()=>{
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...valid,operation:'shell'}))).toThrow('Unsupported');
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...valid,command:'id'}))).toThrow('Unsupported');
 });
 it('rejects unsafe identities and out-of-range quotas',()=>{
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...valid,repositoryId:'../etc'}))).toThrow('repository');
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...valid,worktreeId:'../etc'}))).toThrow('worktree');
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...valid,diskMiB:0}))).toThrow('diskMiB');
  expect(()=>parseQuotaBrokerRequest(JSON.stringify({...valid,diskMiB:102401}))).toThrow('diskMiB');
 });
 it('rejects malformed, array and oversized requests',()=>{
  expect(()=>parseQuotaBrokerRequest('{')).toThrow('valid JSON');
  expect(()=>parseQuotaBrokerRequest('[]')).toThrow('object');
  expect(()=>parseQuotaBrokerRequest(' '.repeat(1025))).toThrow('too large');
 });
});

describe('quota broker systemd capability boundary',()=>{
 it('grants only the host capabilities required for quota and staging ownership operations',()=>{
  const unit=readFileSync(new URL('../systemd/vps-sandbox-quota-broker.service',import.meta.url),'utf8');
  const match=unit.match(/^CapabilityBoundingSet=(.+)$/m);
  expect(match?.[1].trim().split(' ')).toEqual(['CAP_SYS_ADMIN','CAP_CHOWN','CAP_FOWNER','CAP_DAC_OVERRIDE']);
 });
});

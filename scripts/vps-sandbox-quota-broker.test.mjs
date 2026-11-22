import {describe,expect,it} from 'vitest';
import {parseQuotaBrokerRequest} from './vps-sandbox-quota-broker.mjs';
const valid={operation:'apply',repositoryId:'deputy-proxy-vps-mcp',worktreeId:'134e5321-b4d7-4d4f-be92-ce56a984adaa',diskMiB:2048};
describe('workspace quota broker request validation',()=>{
 it('accepts a valid bounded workspace quota request',()=>expect(parseQuotaBrokerRequest(JSON.stringify(valid))).toEqual(valid));
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

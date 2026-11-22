import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';

const scriptPath=fileURLToPath(new URL('./provision-vps-sandbox-quotas.sh',import.meta.url));

describe('VPS task-workspace quota provisioning script',()=>{
 it('is valid Bash syntax',()=>{
  const result=spawnSync('bash',['-n',scriptPath],{encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);
 });
 it('refuses to enable quotas when ext4 project support or mount options are missing',()=>{
  const source=readFileSync(scriptPath,'utf8');
  expect(source).toContain("grep -qw project");
  expect(source).toContain("grep -Eq '(^|,)(prjquota|pquota)(,|$)'");
  expect(source).toContain('refusing automatic root-filesystem remount');
 });
});

import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';

const scriptPath=fileURLToPath(new URL('./install-vps-sandbox-egress.sh',import.meta.url));
const source=readFileSync(scriptPath,'utf8');
const firewall=source.match(/cat > \/etc\/vps-sandbox\/egress\/egress\.nft <<'NFT'\n([\s\S]*?)\nNFT/);

describe('VPS restricted egress firewall installer',()=>{
 it('is valid Bash syntax',()=>{
  const result=spawnSync('bash',['-n',scriptPath],{encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);
 });
 it('allows only established proxy replies to loopback and slirp clients before the local-destination deny',()=>{
  expect(firewall).not.toBeNull();
  const rules=firewall[1];
  const replyRule='meta skuid vps-egress ct state established ip daddr { 127.0.0.1, 10.0.2.0/24 } tcp sport 3128 accept';
  expect(rules).toContain(replyRule);
  expect(rules.indexOf(replyRule)).toBeLessThan(rules.indexOf('meta skuid vps-egress fib daddr type local drop'));
  expect(rules).toContain('meta skuid vps-egress tcp dport { 80, 443 } accept');
  expect(rules).toContain('meta skuid vps-egress drop');
 });
});

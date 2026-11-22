#!/usr/bin/node
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const roots=['/var/lib/vps-mcp/task-workspaces/worktrees','/srv/vps-mcp-workspaces'];
const mapFile='/etc/vps-sandbox/project-quotas.json';
const repoRe=/^[a-z0-9][a-z0-9._-]{1,199}$/i;
const uuidRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const run=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}}).trim();
export function applyWorkspaceProjectQuota(repositoryId,worktreeId,diskMiB){
 if(process.getuid()!==0)throw Error('Quota helper must run as root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(worktreeId))throw Error('Invalid repository or worktree identity');
 if(!Number.isInteger(diskMiB)||diskMiB<128||diskMiB>102400)throw Error('diskMiB must be between 128 and 102400');
 let workspace;
 for(const root of roots){const candidate=path.join(root,repositoryId,worktreeId);try{const stat=fs.lstatSync(candidate);if(stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(candidate)===candidate){workspace=candidate;break;}}catch{}}
 if(!workspace)throw Error('Workspace must be a canonical directory under an approved task-worktree root');
 const mount=run('/usr/bin/findmnt',['-n','-o','TARGET','-T',workspace]);
 const type=run('/usr/bin/findmnt',['-n','-o','FSTYPE','-T',workspace]);
 const opts=run('/usr/bin/findmnt',['-n','-o','OPTIONS','-T',workspace]).split(',');
 if(type!=='ext4'||!opts.some(x=>x==='prjquota'||x==='pquota'))throw Error('Hard quotas unavailable: filesystem must be ext4 mounted with prjquota');
 const identity=repositoryId+'/'+worktreeId;
 const id=Math.max(10000,Number.parseInt(createHash('sha256').update(identity).digest('hex').slice(0,8),16)&0x7fffffff);
 fs.mkdirSync(path.dirname(mapFile),{recursive:true,mode:0o750});
 let registry={};try{const st=fs.lstatSync(mapFile);if(!st.isFile()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o077)!==0)throw Error('Unsafe quota registry');registry=JSON.parse(fs.readFileSync(mapFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const [otherId,other] of Object.entries(registry))if(Number(otherId)===id&&other!==identity)throw Error('Project quota ID collision');
 run('/usr/bin/chattr',['-R','-p',String(id),workspace]);
 run('/usr/bin/chattr',['+P',workspace]);
 run('/usr/sbin/setquota',['-P',String(id),'0',String(diskMiB*1024),'0','0',mount]);
 registry[String(id)]=identity;
 const tmp=mapFile+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(registry,null,2)+String.fromCharCode(10),{mode:0o600,flag:'wx'});fs.renameSync(tmp,mapFile);fs.chownSync(mapFile,0,0);fs.chmodSync(mapFile,0o600);
 return {ok:true,projectId:id,repositoryId,worktreeId,diskMiB,mountpoint:mount,filesystem:type,enforcement:'ext4-project-quota'};
}
if(import.meta.url==='file://'+process.argv[1]){try{if(process.argv.length!==6||process.argv[2]!=='apply')throw Error('Usage: quota-helper apply <repositoryId> <worktreeId> <diskMiB>');console.log(JSON.stringify(applyWorkspaceProjectQuota(process.argv[3],process.argv[4],Number(process.argv[5]))));}catch(e){console.error(e.message);process.exit(1);}}

#!/usr/bin/node
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const roots=['/var/lib/vps-mcp/task-workspaces/worktrees','/srv/vps-mcp-workspaces'];
const mapFile='/etc/vps-sandbox/project-quotas.json';
const stagingRoot='/var/lib/vps-sandbox-mounts';
const repoRe=/^[a-z0-9][a-z0-9._-]{1,199}$/i;
const uuidRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const run=(cmd,args,timeout=30000)=>execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}}).trim();
export function isMountpoint(target, execFile=execFileSync){try{execFile('/usr/bin/mountpoint',['-q',target],{stdio:'ignore',timeout:5000});return true;}catch(e){if(e.status===32)return false;throw e;}}
export function applyWorkspaceProjectQuota(repositoryId,worktreeId,diskMiB){
 if(process.getuid()!==0)throw Error('Quota helper must run as root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(worktreeId))throw Error('Invalid repository or worktree identity');
 if(!Number.isInteger(diskMiB)||diskMiB<128||diskMiB>102400)throw Error('diskMiB must be between 128 and 102400');
 let workspace;
 for(const root of roots){const candidate=path.join(root,repositoryId,worktreeId);try{const stat=fs.lstatSync(candidate);if(stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(candidate)===candidate){workspace=candidate;break;}}catch{}}
 if(!workspace)throw Error('Workspace must be a canonical directory under an approved task-worktree root');
 const workspaceMount=run('/usr/bin/findmnt',['-n','-o','TARGET','-T',workspace]);
 const type=run('/usr/bin/findmnt',['-n','-o','FSTYPE','-T',workspace]);
 const opts=run('/usr/bin/findmnt',['-n','-o','OPTIONS','-T',workspace]).split(',');
 const workspaceDevice=run('/usr/bin/findmnt',['-n','-o','MAJ:MIN','-T',workspace]);
 let mount=workspaceMount;
 if(workspaceMount!=='/' && workspaceDevice===run('/usr/bin/findmnt',['-n','-o','MAJ:MIN','-T','/'])){
  const rootType=run('/usr/bin/findmnt',['-n','-o','FSTYPE','-T','/']);
  const rootOpts=run('/usr/bin/findmnt',['-n','-o','OPTIONS','-T','/']).split(',');
  if(rootType!=='ext4'||!rootOpts.some(x=>x==='prjquota'||x==='pquota'))throw Error('Underlying root filesystem does not support project quotas');
  mount='/';
 }else if(type!=='ext4'||!opts.some(x=>x==='prjquota'||x==='pquota')){
  throw Error('Hard quotas unavailable: filesystem must be ext4 mounted with prjquota');
 }
 const identity=repositoryId+'/'+worktreeId;
 const id=Math.max(10000,Number.parseInt(createHash('sha256').update(identity).digest('hex').slice(0,8),16)&0x7fffffff);
 fs.mkdirSync(path.dirname(mapFile),{recursive:true,mode:0o750});
 let registry={};try{const st=fs.lstatSync(mapFile);if(!st.isFile()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o077)!==0)throw Error('Unsafe quota registry');registry=JSON.parse(fs.readFileSync(mapFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const [otherId,other] of Object.entries(registry))if(Number(otherId)===id&&other!==identity)throw Error('Project quota ID collision');
 run('/usr/bin/find',['-P',workspace,'-xdev','(', '-type','f','-o','-type','d',')','-exec','/usr/bin/chattr','-p',String(id),'{}','+'],120000);
 run('/usr/bin/chattr',['+P',workspace]);
 run('/usr/sbin/setquota',['-P',String(id),'0',String(diskMiB*1024),'0','0',mount]);
 registry[String(id)]=identity;
 const tmp=mapFile+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(registry,null,2)+String.fromCharCode(10),{mode:0o600,flag:'wx'});fs.renameSync(tmp,mapFile);fs.chownSync(mapFile,0,0);fs.chmodSync(mapFile,0o600);
 return {ok:true,projectId:id,repositoryId,worktreeId,diskMiB,mountpoint:mount,filesystem:type,enforcement:'ext4-project-quota'};
}

export function stageWorkspaceMount(repositoryId,worktreeId,workloadId){
 if(process.getuid()!==0)throw Error('Quota helper must run as root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(worktreeId)||!uuidRe.test(workloadId))throw Error('Invalid staging identity');
 const workspace=resolveWorkspace(repositoryId,worktreeId);
 const target=path.join(stagingRoot,repositoryId,worktreeId,workloadId);
 const sandboxGid=Number(run('/usr/bin/id',['-g','vps-sandbox']));
 fs.mkdirSync(stagingRoot,{recursive:true,mode:0o750});
 for(const directory of [stagingRoot,path.join(stagingRoot,repositoryId),path.join(stagingRoot,repositoryId,worktreeId)]){fs.mkdirSync(directory,{recursive:true,mode:0o750});const entry=fs.lstatSync(directory);if(!entry.isDirectory()||entry.isSymbolicLink()||fs.realpathSync(directory)!==directory)throw Error('Unsafe staging directory');fs.chownSync(directory,0,sandboxGid);fs.chmodSync(directory,0o750);}
 try{fs.mkdirSync(target,{mode:0o750});}catch(e){if(e.code!=='EEXIST')throw e;}
 const st=fs.lstatSync(target);if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(target)!==target)throw Error('Unsafe staging target');
 const mounted=isMountpoint(target);
 if(mounted){const source=run('/usr/bin/findmnt',['-n','-o','FSROOT','--mountpoint',target],10000);if(path.resolve(source)!==workspace)throw Error('Staging target is mounted from a different workspace');}
 else run('/usr/bin/mount',['--bind',workspace,target],30000);
 if(!isMountpoint(target))throw Error('Staging mount did not become visible in the host mount namespace');
 return {ok:true,repositoryId,worktreeId,workloadId,stagedPath:target};
}
export function unstageWorkspaceMount(repositoryId,worktreeId,workloadId){
 if(process.getuid()!==0)throw Error('Quota helper must run as root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(worktreeId)||!uuidRe.test(workloadId))throw Error('Invalid staging identity');
 const candidates=roots.map(root=>path.join(root,repositoryId,worktreeId));
 const target=path.join(stagingRoot,repositoryId,worktreeId,workloadId);
 let targetStat;try{targetStat=fs.lstatSync(target);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(targetStat&&(!targetStat.isDirectory()||targetStat.isSymbolicLink()||fs.realpathSync(target)!==target))throw Error('Unsafe staging target');
 const mounted=Boolean(targetStat)&&isMountpoint(target);
 if(mounted){
  const source=path.resolve(run('/usr/bin/findmnt',['-n','-o','FSROOT','--mountpoint',target],10000));
  if(!candidates.includes(source))throw Error('Refusing to unmount a staging target with a different source');
  run('/usr/bin/umount',['--',target],30000);
 }
 try{fs.rmdirSync(target);}catch(e){if(!['ENOENT','ENOTEMPTY','EBUSY'].includes(e.code))throw e;}
 return {ok:true,repositoryId,worktreeId,workloadId,unstaged:true};
}
function resolveWorkspace(repositoryId,worktreeId){
 for(const candidate of roots.map(root=>path.join(root,repositoryId,worktreeId))){try{const st=fs.lstatSync(candidate);if(st.isDirectory()&&!st.isSymbolicLink()&&fs.realpathSync(candidate)===candidate)return candidate;}catch{}}
 throw Error('Workspace must be a canonical directory under an approved task-worktree root');
}

if(import.meta.url==='file://'+process.argv[1]){try{const op=process.argv[2];let result;if(op==='apply'&&process.argv.length===6)result=applyWorkspaceProjectQuota(process.argv[3],process.argv[4],Number(process.argv[5]));else if(op==='stage'&&process.argv.length===6)result=stageWorkspaceMount(process.argv[3],process.argv[4],process.argv[5]);else if(op==='unstage'&&process.argv.length===6)result=unstageWorkspaceMount(process.argv[3],process.argv[4],process.argv[5]);else throw Error('Invalid quota helper operation or arguments');console.log(JSON.stringify(result));}catch(e){console.error(e.message);process.exit(1);}}

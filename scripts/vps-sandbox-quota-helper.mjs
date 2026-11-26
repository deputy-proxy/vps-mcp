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


export function applyProjectEnvironmentQuota(repositoryId,environmentId,diskMiB){
 if(process.getuid()!==0)throw Error('Quota helper must run as root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(environmentId))throw Error('Invalid project environment identity');
 if(!Number.isInteger(diskMiB)||diskMiB<128||diskMiB>102400)throw Error('diskMiB must be between 128 and 102400');
 const environment=path.join(projectEnvRoot(),repositoryId);
 const st=fs.lstatSync(environment);
 if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(environment)!==environment)throw Error('Project environment must be a canonical directory under the approved project root');
 if(st.uid!==Number(run('/usr/bin/id',['-u',projectEnvOwner()]))||(st.mode&0o002)!==0)throw Error('Project environment root has unexpected ownership or world-writable permissions');
 const workspaceMount=run('/usr/bin/findmnt',['-n','-o','TARGET','-T',environment]);
 const type=run('/usr/bin/findmnt',['-n','-o','FSTYPE','-T',environment]);
 const opts=run('/usr/bin/findmnt',['-n','-o','OPTIONS','-T',environment]).split(',');
 const device=run('/usr/bin/findmnt',['-n','-o','MAJ:MIN','-T',environment]);
 let mount=workspaceMount;
 if(workspaceMount!=='/'&&device===run('/usr/bin/findmnt',['-n','-o','MAJ:MIN','-T','/'])){
  const rootType=run('/usr/bin/findmnt',['-n','-o','FSTYPE','-T','/']);
  const rootOpts=run('/usr/bin/findmnt',['-n','-o','OPTIONS','-T','/']).split(',');
  if(rootType!=='ext4'||!rootOpts.some(x=>x==='prjquota'||x==='pquota'))throw Error('Underlying root filesystem does not support project quotas');
  mount='/';
 }else if(type!=='ext4'||!opts.some(x=>x==='prjquota'||x==='pquota')){
  throw Error('Hard project environment quotas unavailable: filesystem must be ext4 mounted with prjquota');
 }
 const identity='project-environment/'+repositoryId+'/'+environmentId;
 const id=Math.max(10000,Number.parseInt(createHash('sha256').update(identity).digest('hex').slice(0,8),16)&0x7fffffff);
 fs.mkdirSync(path.dirname(mapFile),{recursive:true,mode:0o750});
 let registry={};try{const mapStat=fs.lstatSync(mapFile);if(!mapStat.isFile()||mapStat.isSymbolicLink()||mapStat.uid!==0||(mapStat.mode&0o077)!==0)throw Error('Unsafe quota registry');registry=JSON.parse(fs.readFileSync(mapFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const [otherId,other] of Object.entries(registry))if(Number(otherId)===id&&other!==identity)throw Error('Project quota ID collision');
 run('/usr/bin/find',['-P',environment,'-xdev','(','-type','f','-o','-type','d',')','-exec','/usr/bin/chattr','-p',String(id),'{}','+'],120000);
 run('/usr/bin/chattr',['+P',environment]);
 run('/usr/sbin/setquota',['-P',String(id),'0',String(diskMiB*1024),'0','0',mount]);
 registry[String(id)]=identity;
 const tmp=mapFile+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(registry,null,2)+String.fromCharCode(10),{mode:0o600,flag:'wx'});fs.renameSync(tmp,mapFile);fs.chownSync(mapFile,0,0);fs.chmodSync(mapFile,0o600);
 return {ok:true,projectId:id,repositoryId,environmentId,diskMiB,mountpoint:mount,filesystem:type,enforcement:'ext4-project-quota'};
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


const projectEnvRoot = () => path.resolve(process.env.VPS_SANDBOX_PROJECT_ENV_ROOT || '/var/lib/vps-mcp/project-environments');
const projectEnvOwner = () => {
 const owner=process.env.VPS_SANDBOX_PROJECT_ENV_OWNER || 'vps-mcp';
 if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(owner))throw Error('Project environment owner is invalid');
 return owner;
};
function safeReleaseId(value){if(typeof value!=='string'||!uuidRe.test(value))throw Error('Invalid project release identity');return value.toLowerCase();}
function canonicalDirectory(value,label){
 const st=fs.lstatSync(value);
 if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(value)!==value)throw Error(label+' must be a canonical real directory');
 return value;
}
export function resolveProjectServicePaths(repositoryId,releaseId){
 if(!repoRe.test(repositoryId))throw Error('Invalid repository ID');
 safeReleaseId(releaseId);
 const root=projectEnvRoot();
 if(!path.isAbsolute(root)||root.includes(','))throw Error('Project environment root is invalid');
 canonicalDirectory(root,'Project environment root');
 const environment=canonicalDirectory(path.join(root,repositoryId),'Project environment');
 const releases=canonicalDirectory(path.join(environment,'releases'),'Project releases directory');
 const release=canonicalDirectory(path.join(releases,releaseId),'Project release');
 const storage=canonicalDirectory(path.join(environment,'storage'),'Project storage directory');
 const cache=canonicalDirectory(path.join(environment,'cache'),'Project cache directory');
 const logs=canonicalDirectory(path.join(environment,'logs'),'Project logs directory');
 return {environment,release,storage,cache,logs};
}
function assertProjectEnvironmentOwnership(sources){
 const expectedUid=Number(run('/usr/bin/id',['-u',projectEnvOwner()]));
 for(const [label,directory] of [
  ['project environment root',projectEnvRoot()],['repository environment',sources.environment],
  ['project release',sources.release],['project storage',sources.storage],['project cache',sources.cache],['project logs',sources.logs],
 ]){
  const stat=fs.lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(directory)!==directory)throw Error(label+' is not a canonical real directory');
  if(stat.uid!==expectedUid||(stat.mode&0o002)!==0)throw Error(label+' has unexpected ownership or world-writable permissions');
 }
}

export function projectRuntimeAclPlan(repositoryId,releaseId){
 const sources=resolveProjectServicePaths(repositoryId,releaseId);
 return {readOnly:[sources.release],writable:[sources.storage,sources.cache,sources.logs]};
}
function grantProjectRuntimeAccess(repositoryId,releaseId){
 const plan=projectRuntimeAclPlan(repositoryId,releaseId);
 for(const directory of plan.readOnly)run('/usr/bin/setfacl',['-R','-m','u:vps-sandbox:rX',directory],120000);
 for(const directory of plan.writable){
  run('/usr/bin/setfacl',['-R','-m','u:vps-sandbox:rwX',directory],120000);
  run('/usr/bin/setfacl',['-m','d:u:vps-sandbox:rwX',directory]);
  run('/usr/bin/find',[directory,'-type','d','-exec','/usr/bin/setfacl','-m','d:u:vps-sandbox:rwX','{}','+'],120000);
 }
}
function revokeAclTree(directory,defaultAcl){
 const expression=defaultAcl?'^default:user:vps-sandbox:':'^user:vps-sandbox:';
 const acl=defaultAcl?'d:u:vps-sandbox':'u:vps-sandbox';
 run('/usr/bin/find',[directory,...(defaultAcl?['-type','d']:['(','-type','f','-o','-type','d',')']),'-exec','/bin/sh','-c',
  'for p do if /usr/bin/getfacl -cp "$p" | /usr/bin/grep -q "'+expression+'"; then /usr/bin/setfacl -x '+acl+' "$p"; fi; done',
  'sh','{}','+'],120000);
}
function revokeProjectRuntimeAccess(repositoryId,releaseId){
 const plan=projectRuntimeAclPlan(repositoryId,releaseId);
 for(const directory of [...plan.readOnly,...plan.writable])revokeAclTree(directory,false);
 for(const directory of plan.writable)revokeAclTree(directory,true);
}
function ensureProjectStagingDirectory(target,sandboxGid){
 fs.mkdirSync(target,{recursive:true,mode:0o750});
 const st=fs.lstatSync(target);
 if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(target)!==target)throw Error('Unsafe project staging directory');
 fs.chownSync(target,0,sandboxGid);fs.chmodSync(target,0o750);
}
function mountProjectPath(source,target,readOnly){
 try{fs.mkdirSync(target,{mode:0o750});}catch(e){if(e.code!=='EEXIST')throw e;}
 const st=fs.lstatSync(target);
 if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(target)!==target)throw Error('Unsafe project staging target');
 let created=false;
 if(isMountpoint(target)){
  const mountedSource=path.resolve(run('/usr/bin/findmnt',['-n','-o','FSROOT','--mountpoint',target],10000));
  if(mountedSource!==source)throw Error('Project staging target is mounted from a different source');
 }else{
  run('/usr/bin/mount',['--bind',source,target],30000);
  created=true;
 }
 try{
  run('/usr/bin/mount',['-o',readOnly?'remount,bind,ro,nosuid,nodev':'remount,bind,rw,nosuid,nodev','--',target],30000);
  if(!isMountpoint(target))throw Error('Project staging mount did not become visible in the host mount namespace');
  const options=run('/usr/bin/findmnt',['-n','-o','OPTIONS','--mountpoint',target],10000).split(',');
  if(readOnly&&!options.includes('ro'))throw Error('Project release mount is not read-only');
  if(!readOnly&&options.includes('ro'))throw Error('Project data mount is not writable');
  if(!options.includes('nosuid')||!options.includes('nodev'))throw Error('Project mount must enforce nosuid and nodev');
  return created;
 }catch(error){
  if(created){
   try{
    if(isMountpoint(target)){
     const mountedSource=path.resolve(run('/usr/bin/findmnt',['-n','-o','FSROOT','--mountpoint',target],10000));
     if(mountedSource===source)run('/usr/bin/umount',['--',target],30000);
    }
   }catch{}
  }
  throw error;
 }
}
export function stageProjectServiceMounts(repositoryId,workloadId,releaseId){
 if(process.getuid()!==0)throw Error('Quota helper must run as root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(workloadId))throw Error('Invalid project staging identity');
 const sources=resolveProjectServicePaths(repositoryId,releaseId);
 assertProjectEnvironmentOwnership(sources);
 const sandboxGid=Number(run('/usr/bin/id',['-g','vps-sandbox']));
 const base=path.join(stagingRoot,'projects',repositoryId,workloadId);
 ensureProjectStagingDirectory(path.join(stagingRoot,'projects'),sandboxGid);
 ensureProjectStagingDirectory(path.join(stagingRoot,'projects',repositoryId),sandboxGid);
 ensureProjectStagingDirectory(base,sandboxGid);
 const targets={release:path.join(base,'release'),storage:path.join(base,'storage'),cache:path.join(base,'cache'),logs:path.join(base,'logs')};
 for(const target of Object.values(targets))try{fs.mkdirSync(target,{mode:0o750});}catch(e){if(e.code!=='EEXIST')throw e;}
 const keys=['release','storage','cache','logs'];
 const existing=[];
 for(const key of keys){
  if(!isMountpoint(targets[key]))continue;
  const mountedSource=path.resolve(run('/usr/bin/findmnt',['-n','-o','FSROOT','--mountpoint',targets[key]],10000));
  if(mountedSource!==sources[key])throw Error('Project staging target is mounted from a different source');
  existing.push(key);
 }
 if(existing.length!==0&&existing.length!==keys.length)throw Error('Partial project mount set exists; refusing to alter an inconsistent workload');
 const allExisting=existing.length===keys.length;
 const created=[];
 try{
  grantProjectRuntimeAccess(repositoryId,releaseId);
  for(const key of keys)if(mountProjectPath(sources[key],targets[key],key==='release'))created.push(key);
 }catch(error){
  for(const key of created.reverse()){
   const target=targets[key];
   try{
    if(isMountpoint(target)){
     const mountedSource=path.resolve(run('/usr/bin/findmnt',['-n','-o','FSROOT','--mountpoint',target],10000));
     if(mountedSource===sources[key])run('/usr/bin/umount',['--',target],30000);
    }
   }catch{}
  }
  if(!allExisting){
   try{revokeProjectRuntimeAccess(repositoryId,releaseId);}catch{}
   for(const target of Object.values(targets))try{if(!isMountpoint(target))fs.rmdirSync(target);}catch{}
   try{fs.rmdirSync(base);}catch{}
  }
  throw error;
 }
 return {ok:true,repositoryId,workloadId,releaseId,stagedPaths:targets};
}
export function unstageProjectServiceMounts(repositoryId,workloadId,releaseId){
 if(process.getuid()!==0)throw Error('Quota helper must run as root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(workloadId))throw Error('Invalid project staging identity');
 const sources=resolveProjectServicePaths(repositoryId,releaseId);
 const base=path.join(stagingRoot,'projects',repositoryId,workloadId);
 const targets={release:path.join(base,'release'),storage:path.join(base,'storage'),cache:path.join(base,'cache'),logs:path.join(base,'logs')};
 for(const key of ['logs','cache','storage','release']){
  const target=targets[key];let st;try{st=fs.lstatSync(target);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(target)!==target)throw Error('Unsafe project staging target');
  if(isMountpoint(target)){
   const mountedSource=path.resolve(run('/usr/bin/findmnt',['-n','-o','FSROOT','--mountpoint',target],10000));
   if(mountedSource!==sources[key])throw Error('Refusing to unmount a project staging target with a different source');
   run('/usr/bin/umount',['--',target],30000);
  }
  try{fs.rmdirSync(target);}catch(e){if(!['ENOENT','ENOTEMPTY','EBUSY'].includes(e.code))throw e;}
 }
 try{fs.rmdirSync(base);}catch(e){if(!['ENOENT','ENOTEMPTY','EBUSY'].includes(e.code))throw e;}
 revokeProjectRuntimeAccess(repositoryId,releaseId);
 return {ok:true,repositoryId,workloadId,releaseId,unstaged:true};
}

if(import.meta.url==='file://'+process.argv[1]){try{const op=process.argv[2];let result;if(op==='apply'&&process.argv.length===6)result=applyWorkspaceProjectQuota(process.argv[3],process.argv[4],Number(process.argv[5]));else if(op==='stage'&&process.argv.length===6)result=stageWorkspaceMount(process.argv[3],process.argv[4],process.argv[5]);else if(op==='unstage'&&process.argv.length===6)result=unstageWorkspaceMount(process.argv[3],process.argv[4],process.argv[5]);else if(op==='apply-project'&&process.argv.length===6)result=applyProjectEnvironmentQuota(process.argv[3],process.argv[4],Number(process.argv[5]));else if(op==='stage-project'&&process.argv.length===6)result=stageProjectServiceMounts(process.argv[3],process.argv[4],process.argv[5]);else if(op==='unstage-project'&&process.argv.length===6)result=unstageProjectServiceMounts(process.argv[3],process.argv[4],process.argv[5]);else throw Error('Invalid quota helper operation or arguments');console.log(JSON.stringify(result));}catch(e){console.error(e.message);process.exit(1);}}

#!/usr/bin/node
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
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
 const configured=projectEnvironmentRootForRepository(repositoryId);
 const environment=path.join(configured.root,repositoryId);
 const st=fs.lstatSync(environment);
 if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(environment)!==environment)throw Error('Project environment must be a canonical directory under the approved project root');
 if(st.uid!==Number(run('/usr/bin/id',['-u',configured.owner]))||(st.mode&0o002)!==0)throw Error('Project environment root has unexpected ownership or world-writable permissions');
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


export function configuredProjectEnvironmentRoots(env=process.env){
 let entries;
 if(env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON){
  try{entries=JSON.parse(env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON);}catch{throw Error('Project environment roots configuration must be valid JSON');}
  if(!Array.isArray(entries)||entries.length<1||entries.length>8)throw Error('Project environment roots configuration must contain between one and eight roots');
 }else entries=[{root:env.VPS_SANDBOX_PROJECT_ENV_ROOT||'/var/lib/vps-mcp/project-environments',owner:env.VPS_SANDBOX_PROJECT_ENV_OWNER||'vps-mcp'}];
 const seen=new Set();
 return entries.map(entry=>{
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||typeof entry.root!=='string'||typeof entry.owner!=='string')throw Error('Project environment root entry is invalid');
  const root=path.resolve(entry.root),owner=entry.owner;
  if(!path.isAbsolute(entry.root)||entry.root.includes(',')||!/^\/[A-Za-z0-9._/-]+$/.test(entry.root)||!/^([a-z_][a-z0-9_-]{0,31})$/.test(owner))throw Error('Project environment root or owner is invalid');
  if(seen.has(root))throw Error('Project environment roots must be unique');seen.add(root);
  return {root,owner};
 });
}
function projectEnvironmentRootForRepository(repositoryId){
 const matches=[];
 for(const entry of configuredProjectEnvironmentRoots()){
  const candidate=path.join(entry.root,repositoryId);
  try{const st=fs.lstatSync(candidate);if(st.isDirectory()&&!st.isSymbolicLink()&&fs.realpathSync(candidate)===candidate)matches.push(entry);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 if(matches.length===0)throw Error('Project environment must exist under an approved project root');
 if(matches.length!==1)throw Error('Project environment repository exists under multiple approved roots; refusing ambiguous ownership');
 return matches[0];
}
function safeReleaseId(value){if(typeof value!=='string'||!uuidRe.test(value))throw Error('Invalid project release identity');return value.toLowerCase();}
function canonicalDirectory(value,label){
 const st=fs.lstatSync(value);
 if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(value)!==value)throw Error(label+' must be a canonical real directory');
 return value;
}
export function resolveProjectServicePaths(repositoryId,releaseId){
 if(!repoRe.test(repositoryId))throw Error('Invalid repository ID');
 safeReleaseId(releaseId);
 const configured=projectEnvironmentRootForRepository(repositoryId);
 const root=configured.root;
 if(!path.isAbsolute(root)||root.includes(','))throw Error('Project environment root is invalid');
 canonicalDirectory(root,'Project environment root');
 const environment=canonicalDirectory(path.join(root,repositoryId),'Project environment');
 const releases=canonicalDirectory(path.join(environment,'releases'),'Project releases directory');
 const release=canonicalDirectory(path.join(releases,releaseId),'Project release');
 const storage=canonicalDirectory(path.join(environment,'storage'),'Project storage directory');
 const cache=canonicalDirectory(path.join(environment,'cache'),'Project cache directory');
 const logs=canonicalDirectory(path.join(environment,'logs'),'Project logs directory');
 return {environment,release,storage,cache,logs,runtimeConfig:path.join(environment,'secrets','application')};
}
function assertProjectEnvironmentOwnership(sources,repositoryId){
 const configured=projectEnvironmentRootForRepository(repositoryId);
 const expectedUid=Number(run('/usr/bin/id',['-u',configured.owner]));
 for(const [label,directory] of [
  ['project environment root',configured.root],['repository environment',sources.environment],
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
 assertProjectEnvironmentOwnership(sources,repositoryId);
 const sandboxGid=Number(run('/usr/bin/id',['-g','vps-sandbox']));
 const base=path.join(stagingRoot,'projects',repositoryId,workloadId);
 ensureProjectStagingDirectory(path.join(stagingRoot,'projects'),sandboxGid);
 ensureProjectStagingDirectory(path.join(stagingRoot,'projects',repositoryId),sandboxGid);
 ensureProjectStagingDirectory(base,sandboxGid);
 const runtimeConfig=canonicalDirectory(path.join(sources.environment,'secrets','application'),'Project runtime configuration directory');
 const runtimeConfigStat=fs.lstatSync(runtimeConfig);
 if(runtimeConfigStat.uid!==0||runtimeConfigStat.gid!==sandboxGid||(runtimeConfigStat.mode&0o777)!==0o750)throw Error('Project runtime configuration has unsafe ownership or permissions');
 const runtimeEnv=path.join(runtimeConfig,'runtime.env');
 const runtimeEnvStat=fs.lstatSync(runtimeEnv);
 if(!runtimeEnvStat.isFile()||runtimeEnvStat.isSymbolicLink()||runtimeEnvStat.uid!==0||runtimeEnvStat.gid!==sandboxGid||(runtimeEnvStat.mode&0o777)!==0o440)throw Error('Project runtime environment file has unsafe ownership or permissions');
 const targets={release:path.join(base,'release'),storage:path.join(base,'storage'),cache:path.join(base,'cache'),logs:path.join(base,'logs'),runtimeConfig:path.join(base,'runtime-config')};
 for(const target of Object.values(targets))try{fs.mkdirSync(target,{mode:0o750});}catch(e){if(e.code!=='EEXIST')throw e;}
 const keys=['release','storage','cache','logs','runtimeConfig'];
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
  for(const key of keys)if(mountProjectPath(sources[key],targets[key],key==='release'||key==='runtimeConfig'))created.push(key);
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
 return {ok:true,repositoryId,workloadId,releaseId,stagedPaths:{...targets,runtimeEnv:path.join(targets.runtimeConfig,'runtime.env')}};
}
export function unstageProjectServiceMounts(repositoryId,workloadId,releaseId){
 if(process.getuid()!==0)throw Error('Quota helper must run as root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(workloadId))throw Error('Invalid project staging identity');
 const sources=resolveProjectServicePaths(repositoryId,releaseId);
 const base=path.join(stagingRoot,'projects',repositoryId,workloadId);
 const runtimeConfig=canonicalDirectory(path.join(sources.environment,'secrets','application'),'Project runtime configuration directory');
 const runtimeConfigStat=fs.lstatSync(runtimeConfig);
 if(runtimeConfigStat.uid!==0||runtimeConfigStat.gid!==sandboxGid||(runtimeConfigStat.mode&0o777)!==0o750)throw Error('Project runtime configuration has unsafe ownership or permissions');
 const runtimeEnv=path.join(runtimeConfig,'runtime.env');
 const runtimeEnvStat=fs.lstatSync(runtimeEnv);
 if(!runtimeEnvStat.isFile()||runtimeEnvStat.isSymbolicLink()||runtimeEnvStat.uid!==0||runtimeEnvStat.gid!==sandboxGid||(runtimeEnvStat.mode&0o777)!==0o440)throw Error('Project runtime environment file has unsafe ownership or permissions');
 const targets={release:path.join(base,'release'),storage:path.join(base,'storage'),cache:path.join(base,'cache'),logs:path.join(base,'logs'),runtimeConfig:path.join(base,'runtime-config')};
 for(const key of ['runtimeConfig','logs','cache','storage','release']){
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

function safeEnvironmentId(value){if(typeof value!=='string'||!uuidRe.test(value))throw Error('Invalid project environment identity');return value.toLowerCase();}
function ensureSecretDirectory(directory,sandboxGid){
 fs.mkdirSync(directory,{recursive:true,mode:0o750});
 const st=fs.lstatSync(directory);
 if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(directory)!==directory)throw Error('Unsafe project secret directory');
 fs.chownSync(directory,0,sandboxGid);fs.chmodSync(directory,0o750);
}
function writeProtectedSecret(file,content,sandboxGid){
 const directory=path.dirname(file);ensureSecretDirectory(directory,sandboxGid);
 try{
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==0||st.gid!==sandboxGid||(st.mode&0o777)!==0o440)throw Error('Existing project secret has unsafe ownership or permissions');
  return false;
 }catch(error){if(error.code!=='ENOENT')throw error;}
 const temporary=file+'.'+process.pid+'.'+randomBytes(6).toString('hex')+'.tmp';
 const fd=fs.openSync(temporary,'wx',0o440);
 try{fs.writeFileSync(fd,content,{encoding:'utf8'});fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.chownSync(temporary,0,sandboxGid);fs.chmodSync(temporary,0o440);fs.renameSync(temporary,file);
 return true;
}
export function prepareProjectDependencySecrets(repositoryId,environmentId,mysqlEnabled,redisEnabled){
 if(process.getuid()!==0)throw Error('Project dependency secrets must be prepared by root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(environmentId)||typeof mysqlEnabled!=='boolean'||typeof redisEnabled!=='boolean')throw Error('Invalid project dependency secret identity');
 const configured=projectEnvironmentRootForRepository(repositoryId);
 const expectedUid=Number(run('/usr/bin/id',['-u',configured.owner]));
 const expectedGid=Number(run('/usr/bin/id',['-g',configured.owner]));
 const environment=canonicalDirectory(path.join(configured.root,repositoryId),'Project environment');
 const secrets=path.join(environment,'secrets');const mysql=path.join(secrets,'mysql');const redis=path.join(secrets,'redis');
 const sandboxGid=Number(run('/usr/bin/id',['-g','vps-sandbox']));
 const application=path.join(secrets,'application');const backupSecrets=path.join(secrets,'backup');
 ensureSecretDirectory(secrets,sandboxGid);ensureSecretDirectory(application,sandboxGid);ensureSecretDirectory(backupSecrets,sandboxGid);
 if(mysqlEnabled)ensureSecretDirectory(mysql,sandboxGid);
 if(redisEnabled)ensureSecretDirectory(redis,sandboxGid);
 const writeIfAbsent=(file,content)=>{
  try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==0||st.gid!==sandboxGid||(st.mode&0o777)!==0o440)throw Error('Existing project secret has unsafe ownership or permissions');return fs.readFileSync(file,'utf8');}
  catch(error){if(error.code!=='ENOENT')throw error;writeProtectedSecret(file,content,sandboxGid);return content;}
 };
 const appKey=writeIfAbsent(path.join(application,'app-key'),randomBytes(32).toString('base64')).trim();
 let appPassword='';
 if(mysqlEnabled){
  const rootPassword=writeIfAbsent(path.join(mysql,'mysql-root-password'),randomBytes(48).toString('base64url')).trim();
  appPassword=writeIfAbsent(path.join(application,'mysql-app-password'),randomBytes(48).toString('base64url')).trim();
  const rootClientConfig=`[client]\nuser=root\npassword=${rootPassword}\nhost=127.0.0.1\nprotocol=TCP\n`;
  if(writeIfAbsent(path.join(mysql,'mysql-root.cnf'),rootClientConfig)!==rootClientConfig)throw Error('Existing MySQL root client configuration does not match its protected credential');
  const initializeSql=`CREATE DATABASE IF NOT EXISTS app CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\nCREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY '${appPassword}';\nALTER USER 'app'@'%' IDENTIFIED BY '${appPassword}';\nGRANT ALL PRIVILEGES ON app.* TO 'app'@'%';\nFLUSH PRIVILEGES;\n`;
  if(writeIfAbsent(path.join(mysql,'initialize.sql'),initializeSql)!==initializeSql)throw Error('Existing MySQL initialization script does not match its protected application credential');
 }
 let redisPassword='';
 if(redisEnabled){
  const redisAcl=writeIfAbsent(path.join(redis,'redis-users.acl'),`user default off\nuser app on >${randomBytes(48).toString('base64url')} ~* &* +@all\n`);
  const redisPasswordMatch=/^user default off\nuser app on >([A-Za-z0-9_-]+) ~\* &\* \+@all\n$/.exec(redisAcl);
  if(!redisPasswordMatch)throw Error('Existing Redis ACL file does not match the isolated application-user policy');
  redisPassword=redisPasswordMatch[1];
  if(writeIfAbsent(path.join(redis,'redis-app-password'),redisPassword)!==redisPassword)throw Error('Existing Redis application credential does not match its protected ACL');
  const redisConfig='bind 0.0.0.0\nprotected-mode yes\naclfile /run/secrets/redis-users.acl\ndir /data\nsave ""\nappendonly no\n';
  if(writeIfAbsent(path.join(redis,'redis.conf'),redisConfig)!==redisConfig)throw Error('Existing Redis configuration does not match the approved ephemeral-cache policy');
 }
 writeIfAbsent(path.join(backupSecrets,'backup.key'),randomBytes(32).toString('base64url'));
 const backups=path.join(environment,'backups');
 fs.mkdirSync(backups,{recursive:true,mode:0o700});
 const backupsStat=fs.lstatSync(backups);
 if(!backupsStat.isDirectory()||backupsStat.isSymbolicLink()||fs.realpathSync(backups)!==backups)throw Error('Project backup path is not a canonical directory');
 fs.chownSync(backups,expectedUid,expectedGid);
 fs.chmodSync(backups,0o700);
 run('/usr/bin/setfacl',['-m','u:vps-sandbox:rwX','-m','d:u:vps-sandbox:rwX',backups]);
 const runtimeEnv=[
  'APP_ENV=local','APP_DEBUG=true',`APP_KEY=base64:${appKey}`,'LOG_CHANNEL=stderr',
  ...(mysqlEnabled?['DB_CONNECTION=mysql','DB_HOST=127.0.0.1','DB_PORT=3306','DB_DATABASE=app','DB_USERNAME=app',`DB_PASSWORD=${appPassword}`]:[]),
  `CACHE_STORE=${redisEnabled?'redis':'file'}`,'SESSION_DRIVER=file','QUEUE_CONNECTION=sync',
  ...(redisEnabled?['REDIS_CLIENT=phpredis','REDIS_HOST=127.0.0.1','REDIS_PASSWORD='+redisPassword,'REDIS_PORT=6379','REDIS_USERNAME=app']:[]),
 ].join('\n')+'\n';
 if(writeIfAbsent(path.join(application,'runtime.env'),runtimeEnv)!==runtimeEnv)throw Error('Existing project runtime configuration does not match its protected dependency credentials and profile selection');
 return {ok:true,repositoryId,environmentId,mysqlEnabled,redisEnabled,secretPaths:{mysql:mysqlEnabled?'/secrets/mysql':null,redis:redisEnabled?'/secrets/redis':null,application:'/secrets/application',backup:'/secrets/backup'},createdWithoutReturningValues:true};
}

export function stageProjectDependencyMounts(repositoryId,workloadId,dependency){
 if(process.getuid()!==0)throw Error('Project dependency staging must run as root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(workloadId)||!['mysql','redis'].includes(dependency))throw Error('Invalid project dependency staging identity');
 const configured=projectEnvironmentRootForRepository(repositoryId);
 const environment=canonicalDirectory(path.join(configured.root,repositoryId),'Project environment');
 const sourceData=dependency==='mysql'?canonicalDirectory(path.join(environment,'database'),'Project database directory'):null;
 const sourceSecrets=canonicalDirectory(path.join(environment,'secrets',dependency),'Project dependency secret directory');
 const sandboxGid=Number(run('/usr/bin/id',['-g','vps-sandbox']));
 const base=path.join(stagingRoot,'projects',repositoryId,workloadId);
 ensureProjectStagingDirectory(path.join(stagingRoot,'projects'),sandboxGid);
 ensureProjectStagingDirectory(path.join(stagingRoot,'projects',repositoryId),sandboxGid);
 ensureProjectStagingDirectory(base,sandboxGid);
 const targets={data:path.join(base,'dependency-data'),secrets:path.join(base,'secrets')};
 if(dependency==='mysql'){
  const createdData=mountProjectPath(sourceData,targets.data,false);
  const createdSecrets=mountProjectPath(sourceSecrets,targets.secrets,true);
  return {ok:true,repositoryId,workloadId,dependency,stagedPaths:targets,created:[createdData,createdSecrets]};
 }
 const createdSecrets=mountProjectPath(sourceSecrets,targets.secrets,true);
 return {ok:true,repositoryId,workloadId,dependency,stagedPaths:targets,created:[createdSecrets]};
}
export function unstageProjectDependencyMounts(repositoryId,workloadId,dependency){
 if(process.getuid()!==0)throw Error('Project dependency unstaging must run as root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(workloadId)||!['mysql','redis'].includes(dependency))throw Error('Invalid project dependency staging identity');
 const configured=projectEnvironmentRootForRepository(repositoryId);
 const environment=canonicalDirectory(path.join(configured.root,repositoryId),'Project environment');
 const sources={data:dependency==='mysql'?canonicalDirectory(path.join(environment,'database'),'Project database directory'):null,secrets:canonicalDirectory(path.join(environment,'secrets',dependency),'Project dependency secret directory')};
 const base=path.join(stagingRoot,'projects',repositoryId,workloadId);
 const targets={data:path.join(base,'dependency-data'),secrets:path.join(base,'secrets')};
 for(const key of ['secrets','data']){
  if(!sources[key])continue;
  const target=targets[key];let st;try{st=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(target)!==target)throw Error('Unsafe project dependency staging target');
  if(isMountpoint(target)){
   const mountedSource=path.resolve(run('/usr/bin/findmnt',['-n','-o','FSROOT','--mountpoint',target],10000));
   if(mountedSource!==sources[key])throw Error('Refusing to unmount a project dependency staging target with a different source');
   run('/usr/bin/umount',['--',target],30000);
  }
  try{fs.rmdirSync(target);}catch(error){if(!['ENOENT','ENOTEMPTY','EBUSY'].includes(error.code))throw error;}
 }
 try{fs.rmdirSync(base);}catch(error){if(!['ENOENT','ENOTEMPTY','EBUSY'].includes(error.code))throw error;}
 return {ok:true,repositoryId,workloadId,dependency,unstaged:true};
}

export function stageProjectBackupMounts(repositoryId,environmentId,backupId){
 if(process.getuid()!==0)throw Error('Project backup staging must run as root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(environmentId)||!uuidRe.test(backupId))throw Error('Invalid project backup staging identity');
 const configured=projectEnvironmentRootForRepository(repositoryId);
 const environment=canonicalDirectory(path.join(configured.root,repositoryId),'Project environment');
 const backups=canonicalDirectory(path.join(environment,'backups'),'Project backup directory');
 const secrets=canonicalDirectory(path.join(environment,'secrets','backup'),'Project backup secret directory');
 const key=path.join(secrets,'backup.key');const keyStat=fs.lstatSync(key);
 if(!keyStat.isFile()||keyStat.isSymbolicLink()||keyStat.uid!==0||(keyStat.mode&0o777)!==0o440)throw Error('Project backup key has unsafe ownership or permissions');
 const sandboxGid=Number(run('/usr/bin/id',['-g','vps-sandbox']));
 if(keyStat.gid!==sandboxGid)throw Error('Project backup key group does not match the sandbox runtime');
 const base=path.join(stagingRoot,'projects',repositoryId,backupId);
 ensureProjectStagingDirectory(path.join(stagingRoot,'projects'),sandboxGid);
 ensureProjectStagingDirectory(path.join(stagingRoot,'projects',repositoryId),sandboxGid);
 ensureProjectStagingDirectory(base,sandboxGid);
 const targets={backups:path.join(base,'backups'),secrets:path.join(base,'secrets')};
 mountProjectPath(backups,targets.backups,false);mountProjectPath(secrets,targets.secrets,true);
 return {ok:true,repositoryId,environmentId,backupId,stagedPaths:targets};
}
export function unstageProjectBackupMounts(repositoryId,environmentId,backupId){
 if(process.getuid()!==0)throw Error('Project backup unstaging must run as root');
 if(!repoRe.test(repositoryId)||!uuidRe.test(environmentId)||!uuidRe.test(backupId))throw Error('Invalid project backup staging identity');
 const configured=projectEnvironmentRootForRepository(repositoryId);
 const environment=canonicalDirectory(path.join(configured.root,repositoryId),'Project environment');
 const sources={backups:canonicalDirectory(path.join(environment,'backups'),'Project backup directory'),secrets:canonicalDirectory(path.join(environment,'secrets','backup'),'Project backup secret directory')};
 const base=path.join(stagingRoot,'projects',repositoryId,backupId);
 const targets={backups:path.join(base,'backups'),secrets:path.join(base,'secrets')};
 for(const key of ['secrets','backups']){
  const target=targets[key];let st;try{st=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(target)!==target)throw Error('Unsafe project backup staging target');
  if(isMountpoint(target)){
   const mountedSource=path.resolve(run('/usr/bin/findmnt',['-n','-o','FSROOT','--mountpoint',target],10000));
   if(mountedSource!==sources[key])throw Error('Refusing to unmount a project backup target with a different source');
   run('/usr/bin/umount',['--',target],30000);
  }
  try{fs.rmdirSync(target);}catch(error){if(!['ENOENT','ENOTEMPTY','EBUSY'].includes(error.code))throw error;}
 }
 try{fs.rmdirSync(base);}catch(error){if(!['ENOENT','ENOTEMPTY','EBUSY'].includes(error.code))throw error;}
 return {ok:true,repositoryId,environmentId,backupId,unstaged:true};
}

if(import.meta.url==='file://'+process.argv[1]){try{const op=process.argv[2];let result;if(op==='apply'&&process.argv.length===6)result=applyWorkspaceProjectQuota(process.argv[3],process.argv[4],Number(process.argv[5]));else if(op==='stage'&&process.argv.length===6)result=stageWorkspaceMount(process.argv[3],process.argv[4],process.argv[5]);else if(op==='unstage'&&process.argv.length===6)result=unstageWorkspaceMount(process.argv[3],process.argv[4],process.argv[5]);else if(op==='apply-project'&&process.argv.length===6)result=applyProjectEnvironmentQuota(process.argv[3],process.argv[4],Number(process.argv[5]));else if(op==='stage-project'&&process.argv.length===6)result=stageProjectServiceMounts(process.argv[3],process.argv[4],process.argv[5]);else if(op==='unstage-project'&&process.argv.length===6)result=unstageProjectServiceMounts(process.argv[3],process.argv[4],process.argv[5]);else if(op==='prepare-dependencies'&&process.argv.length===7)result=prepareProjectDependencySecrets(process.argv[3],process.argv[4],process.argv[5]==='true',process.argv[6]==='true');else if(op==='stage-dependency'&&process.argv.length===6)result=stageProjectDependencyMounts(process.argv[3],process.argv[4],process.argv[5]);else if(op==='unstage-dependency'&&process.argv.length===6)result=unstageProjectDependencyMounts(process.argv[3],process.argv[4],process.argv[5]);else if(op==='stage-backup'&&process.argv.length===6)result=stageProjectBackupMounts(process.argv[3],process.argv[4],process.argv[5]);else if(op==='unstage-backup'&&process.argv.length===6)result=unstageProjectBackupMounts(process.argv[3],process.argv[4],process.argv[5]);else throw Error('Invalid quota helper operation or arguments');console.log(JSON.stringify(result));}catch(e){console.error(e.message);process.exit(1);}}

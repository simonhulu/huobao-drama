import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'

const backend=fileURLToPath(new URL('../',import.meta.url)),root=path.dirname(backend.replace(/\/$/,''))
const label='com.huobao.storage-maintenance',directory=path.join(os.homedir(),'Library/LaunchAgents')
fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(path.join(root,'.logs'),{recursive:true})
const filename=path.join(directory,label+'.plist')
const plist={Label:label,ProgramArguments:[fs.existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath,
  '--import','tsx',path.join(backend,'scripts/storage-maintenance.ts'),'serve'],WorkingDirectory:backend,
  EnvironmentVariables:{PATH:process.env.PATH || '/opt/homebrew/bin:/usr/bin:/bin',TASK_WORKER_DISABLED:'1'},
  RunAtLoad:true,KeepAlive:true,ThrottleInterval:30,Umask:63,
  StandardOutPath:path.join(root,'.logs/storage-maintenance.log'),StandardErrorPath:path.join(root,'.logs/storage-maintenance.log')}
execFileSync('/usr/bin/plutil',['-convert','xml1','-o',filename,'-'],{input:JSON.stringify(plist)})
const domain=`gui/${process.getuid()}`
try {execFileSync('/bin/launchctl',['bootout',`${domain}/${label}`],{stdio:'ignore'})} catch {}
execFileSync('/bin/launchctl',['bootstrap',domain,filename])
console.log(`Installed ${filename}`)

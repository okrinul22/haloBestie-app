import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from './store';
mkdirSync('data',{recursive:true});
const store=new Store(process.env.DATABASE_PATH??'data/halobestie.sqlite');
try {
  const [command,email]=process.argv.slice(2);
  if(command==='backup'){mkdirSync('backups',{recursive:true,mode:0o700});const path=join('backups','halobestie-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8)+'.sqlite');store.backup(path);chmodSync(path,0o600);console.log('Database snapshot saved to '+path);}
  else if(command==='approve-bestie'&&email){store.accounts.approve(email);console.log('Bestie account approved. The listener can now sign in.');}
  else if(command==='make-admin'&&email){store.accounts.makeAdmin(email);console.log('Administrator role granted. Sign in again with role admin to use support endpoints.');}
  else throw new Error('Use approve-bestie <email>, make-admin <email>, or backup');
} finally {store.close();}

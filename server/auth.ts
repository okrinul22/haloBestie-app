import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Role } from '../shared/types';

export interface Account { id:string; email:string; role:Role|'admin'; nickname:string; approved:number }
export class AuthError extends Error {constructor(message:string,public status=401){super(message);}}
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
async function derive(password:string,salt:string) {
  return new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024},(error,key)=>error?reject(error):resolve(key)));
}
export class Accounts {
  constructor(private db:DatabaseSync,private now=()=>Date.now()) {
    db.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,role TEXT NOT NULL,passwordHash TEXT NOT NULL,
      nickname TEXT NOT NULL,approved INTEGER NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions (
        tokenHash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS auth_session_expiry ON auth_sessions(expires);`);
  }
  async register(email:string,password:string,nickname:string,role:Role) {
    const normalized=email.trim().toLowerCase();
    if(this.db.prepare('SELECT id FROM users WHERE email=?').get(normalized))throw new AuthError('An account with this email already exists',409);
    const salt=randomBytes(16).toString('hex');const hash=await derive(password,salt);
    const id=randomUUID();
    try {this.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(id,normalized,role,'scrypt$'+salt+'$'+hash.toString('hex'),nickname,role==='customer'?1:0,this.now());}
    catch(error){if(this.db.prepare('SELECT id FROM users WHERE email=?').get(normalized))throw new AuthError('An account with this email already exists',409);throw error;}
    return this.user(id);
  }
  user(id:string) {return this.db.prepare('SELECT id,email,role,nickname,approved FROM users WHERE id=?').get(id) as unknown as Account;}
  async login(email:string,password:string,role:Account['role']) {
    const row=this.db.prepare('SELECT id,passwordHash FROM users WHERE email=?').get(email.trim().toLowerCase()) as {id:string;passwordHash:string}|undefined;
    const [,salt,encoded]=row?.passwordHash.split('$')??['scrypt','00000000000000000000000000000000','00'.repeat(64)];
    const actual=await derive(password,salt);const expected=Buffer.from(encoded,'hex');
    if(!row||expected.length!==actual.length||!timingSafeEqual(actual,expected))throw new AuthError('Invalid email or password');
    const user=this.user(row.id);
    if(user.role!==role)throw new AuthError('Use the app for your account role',403);
    if(!user.approved)throw new AuthError('Your Bestie account is awaiting approval',403);
    const token=randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM auth_sessions WHERE expires<=?').run(this.now());
    this.db.prepare('INSERT INTO auth_sessions VALUES (?,?,?)').run(digest(token),user.id,this.now()+7*86400000);
    return {user,token};
  }
  authenticate(token:string):Account {
    const session=this.db.prepare('SELECT userId FROM auth_sessions WHERE tokenHash=? AND expires>?').get(digest(token),this.now()) as {userId:string}|undefined;
    if(!session)throw new AuthError('Please sign in to continue');
    const user=this.user(session.userId);
    if(!user?.approved)throw new AuthError('Account access is not approved',403);
    return user;
  }
  logout(token:string){this.db.prepare('DELETE FROM auth_sessions WHERE tokenHash=?').run(digest(token));}
  approve(email:string) {
    const result=this.db.prepare("UPDATE users SET approved=1 WHERE email=? AND role='bestie'").run(email.trim().toLowerCase());
    if(!result.changes)throw new Error('No Bestie account found for that email');
  }
  makeAdmin(email:string){
    const user=this.db.prepare('SELECT id FROM users WHERE email=?').get(email.trim().toLowerCase()) as {id:string}|undefined;
    if(!user)throw new Error('Register the administrator account first');
    this.db.prepare("UPDATE users SET role='admin',approved=1 WHERE id=?").run(user.id);
    this.db.prepare('DELETE FROM auth_sessions WHERE userId=?').run(user.id);
  }
}

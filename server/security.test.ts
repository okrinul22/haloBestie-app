import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from './store';
import {createApp} from './app';
import {relayConfiguration} from './relay';

test('accounts, cookies, ownership, multiple listeners, moderation and revocation',async()=>{
  let time=Date.now();const store=new Store(':memory:',()=>time);const server=createApp(store).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert(address&&typeof address!=='string');
  const root=`http://127.0.0.1:${address.port}`;const password='A-long-private-test-password';
  const call=(path:string,token?:string,body?:unknown,headers:Record<string,string>={})=>fetch(root+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const register=async(email:string,role:'customer'|'bestie',nickname:string)=>{
    const response=await call('/auth/register',undefined,{email,password,role,nickname});assert.equal(response.status,201);return (await response.json()).user as {id:string;email:string;role:string};
  };
  const login=async(email:string,role:string)=>{const response=await call('/auth/login',undefined,{email,password,role});assert.equal(response.status,200);return (await response.json()).token as string;};
  try {
    assert.equal((await call('/api/state')).status,401);assert.equal((await call('/api/state','local-customer')).status,401);
    assert.equal((await call('/auth/register',undefined,{email:'evil@example.test',password,nickname:'Evil',role:'admin'})).status,400);
    const a=await register('Alice@example.test','customer','Alice');
    assert.equal((await call('/auth/register',undefined,{email:'alice@example.test',password,nickname:'Duplicate',role:'customer'})).status,409);
    const b=await register('bob@example.test','customer','Bob');const l1=await register('listener1@example.test','bestie','Listener One');const l2=await register('listener2@example.test','bestie','Listener Two');
    assert.equal((await call('/auth/login',undefined,{email:l1.email,password,role:'bestie'})).status,403);
    store.accounts.approve(l1.email);store.accounts.approve(l2.email);
    const ta=await login(a.email,'customer');const tb=await login(b.email,'customer');const tl1=await login(l1.email,'bestie');const tl2=await login(l2.email,'bestie');
    const credentials=new Map([[l1.id,tl1],[l2.id,tl2]]);
    const hashes=store.db.prepare('SELECT passwordHash FROM users').all() as {passwordHash:string}[];
    assert(hashes.every(r=>!r.passwordHash.includes(password)));assert.notEqual(hashes[0].passwordHash,hashes[1].passwordHash);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE tokenHash=?').get(ta) as {n:number}).n,0);
    assert(store.db.prepare('SELECT userId FROM auth_sessions WHERE tokenHash=?').get(createHash('sha256').update(ta).digest('hex')));
    const web=await call('/auth/login',undefined,{email:a.email,password,role:'customer'},{'x-client-platform':'web'});
    assert.equal(web.status,200);const cookie=web.headers.get('set-cookie')!;assert(cookie.includes('HttpOnly'));assert(cookie.includes('SameSite=Strict'));assert.equal((await web.json()).token,undefined);
    assert.equal((await call('/api/auth/me',undefined,undefined,{cookie:cookie.split(';')[0],'x-app-role':'customer'})).status,200);
    assert.equal((await call('/api/auth/me',undefined,undefined,{cookie:cookie.split(';')[0]})).status,401);
    assert.equal((await call('/auth/login',undefined,{email:a.email,password:'a-wrong-password',role:'customer'})).status,401);
    assert.equal((await call('/auth/login',undefined,{email:a.email,password,role:'bestie'})).status,403);
    const webBestie=await call('/auth/login',undefined,{email:l1.email,password,role:'bestie'},{'x-client-platform':'web'});
    assert.equal(webBestie.status,200);
    const combined=cookie.split(';')[0]+'; '+webBestie.headers.get('set-cookie')!.split(';')[0];
    const customerIdentity=await(await call('/api/auth/me',undefined,undefined,{cookie:combined,'x-app-role':'customer'})).json();
    const listenerIdentity=await(await call('/api/auth/me',undefined,undefined,{cookie:combined,'x-app-role':'bestie'})).json();
    assert.equal(customerIdentity.user.id,a.id);assert.equal(listenerIdentity.user.id,l1.id);
    assert.equal((await call('/api/auth/me',ta,undefined,{'x-app-role':'bestie'})).status,403);
    assert.equal((await call('/api/state',ta,undefined,{origin:'https://untrusted.example'})).status,403);
    await call('/api/availability',tl1,{online:true});await call('/api/availability',tl2,{online:true});
    const ba=await(await call('/api/bookings',ta,{service:'text',minutes:10,customerId:b.id})).json();
    const bb=await(await call('/api/bookings',tb,{service:'text',minutes:10})).json();assert(ba.id&&bb.id&&ba.id!==bb.id);
    assert.equal(ba.customerId,undefined);assert.equal(store.get(ba.id).customerId,a.id);
    for(const suffix of ['/payment-proof','/voice/signals'])assert.equal((await call('/api/bookings/'+ba.id+suffix,tb)).status,404);
    assert.equal((await call('/api/bookings/'+ba.id+'/pay',tb,{outcome:'success'})).status,404);
    assert.equal((await call('/api/state?bookingId='+ba.id,tb)).status,404);
    await call('/api/bookings/'+ba.id+'/pay',ta,{outcome:'success'});await call('/api/bookings/'+bb.id+'/pay',tb,{outcome:'success'});
    const listenerA=store.get(ba.id).bestieId!;const listenerB=store.get(bb.id).bestieId!;assert.notEqual(listenerA,listenerB);
    assert.equal((await call('/api/bookings/'+ba.id+'/accept',credentials.get(listenerB),{})).status,404);
    assert.equal((await call('/api/bookings/'+ba.id+'/accept',credentials.get(listenerA),{})).status,200);
    await call('/api/bookings/'+ba.id+'/ready',ta,{});await call('/api/bookings/'+ba.id+'/ready',credentials.get(listenerA),{});
    const state=await(await call('/api/state',credentials.get(listenerA))).json();assert.equal(state.booking.nickname,'Alice');assert(!JSON.stringify(state).includes(a.email));assert.equal(state.booking.customerId,undefined);
    const report=await(await call('/api/bookings/'+ba.id+'/report',ta,{reason:'Please review this conversation'})).json();assert(report.id);
    assert.equal((await call('/api/bookings/'+ba.id+'/block',ta,{})).status,200);
    assert.equal((await call('/api/admin/reports',ta)).status,403);
    const admin=await register('support@example.test','customer','Support');store.accounts.makeAdmin(admin.email);const adminToken=await login(admin.email,'admin');
    const reports=await(await call('/api/admin/reports',adminToken)).json();assert.equal(reports[0].id,report.id);
    assert.equal((await call('/api/admin/reports/'+report.id+'/resolve',adminToken,{})).status,200);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM support_audit').get() as {n:number}).n,1);
    await call('/api/bookings/'+ba.id+'/end',credentials.get(listenerA),{});
    const next=await(await call('/api/bookings',ta,{service:'text',minutes:10})).json();await call('/api/bookings/'+next.id+'/pay',ta,{outcome:'success'});
    assert.equal(store.get(next.id).bestieId,null);
    await call('/api/bookings/'+bb.id+'/cancel',tb,{});assert.equal(store.get(next.id).bestieId,listenerB);
    assert.equal((await call('/api/auth/logout',ta,{})).status,200);assert.equal((await call('/api/state',ta)).status,401);
    time+=7*86400000+1;assert.equal((await call('/api/state',tb)).status,401);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});

test('TURN credentials are temporary and do not expose private user identifiers',()=>{
  const now=1700000000000;const env={TURN_URLS:'turn:relay.example:3478,turns:relay.example:5349',TURN_SECRET:'server-only-test-secret',VOICE_FORCE_RELAY:'true'};
  const config=relayConfiguration('private-account-id','booking-id',env,now);const ice=config.iceServers[0];assert.equal(config.iceTransportPolicy,'relay');assert.equal(config.relayConfigured,true);
  assert.equal(Number(ice.username!.split(':')[0]),Math.floor(now/1000)+7200);assert(!ice.username!.includes('private-account-id'));
  assert.equal(ice.credential,createHmac('sha1',env.TURN_SECRET).update(ice.username!).digest('base64'));
  assert.deepEqual(relayConfiguration('a','b',{}).iceServers,[]);assert.throws(()=>relayConfiguration('a','b',{TURN_URLS:'http://wrong'}));
});

test('a live SQLite backup preserves accounts and receipts and passes integrity checks',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'halobestie-backup-'));const store=new Store(':memory:');
  try {
    const account=await store.accounts.register('backup@example.test','another-private-password','Backup','customer');
    const b=store.create('text',10,'QRIS',undefined,account.id);store.pay(b.id,'success');
    const path=join(dir,'snapshot.sqlite');store.backup(path);const restored=new DatabaseSync(path,{readOnly:true});
    try {assert.equal((restored.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check,'ok');assert.equal((restored.prepare('SELECT email FROM users WHERE id=?').get(account.id) as {email:string}).email,account.email);assert.equal((restored.prepare('SELECT status FROM payments WHERE targetId=?').get(b.id) as {status:string}).status,'paid');} finally {restored.close();}
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

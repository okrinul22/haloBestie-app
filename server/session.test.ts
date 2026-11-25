import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store';
import { createApp } from './app';

function fixture() {
  let time=1000000;
  const store=new Store(':memory:',()=>time);
  function active() {
    store.availability(true);
    const b=store.create('text',10);
    store.pay(b.id,'success');store.accept(b.id);store.ready(b.id,'bestie');store.ready(b.id,'customer');
    return store.get(b.id);
  }
  return {store,active,advance:(ms:number)=>{time+=ms;},close:()=>store.db.close()};
}
test('failed payment stays unpaid; successful retries match only once; both clients must be ready',()=>{
  const f=fixture();try {
    f.store.availability(true);
    const b=f.store.create('voice',30);
    assert.equal(b.price,65000);
    assert.equal(f.store.pay(b.id,'failure').status,'unpaid');
    assert.equal(f.store.snapshot('bestie').booking,null);
    const paid=f.store.pay(b.id,'success');
    f.advance(1000);
    assert.equal(f.store.pay(b.id,'success').deadline,paid.deadline);
    assert.throws(()=>f.store.create('text',10));
    assert.equal(f.store.accept(b.id).status,'connecting');
    assert.equal(f.store.ready(b.id,'customer').started,null);
    const started=f.store.ready(b.id,'bestie');
    assert.equal(started.status,'active');
    f.advance(1000);
    assert.equal(f.store.ready(b.id,'customer').ends,started.ends);
  } finally { f.close(); }
});
test('unmatched payment refunds once after 30 seconds; connecting no-show also refunds',()=>{
  const f=fixture();try {
    const b=f.store.create('text',10); f.store.pay(b.id,'success');
    f.advance(30000); f.store.sweep();
    assert.equal(f.store.get(b.id).status,'cancelled');
    assert.equal(f.store.get(b.id).refund,15000);
    f.store.sweep(); assert.equal(f.store.pay(b.id,'success').refund,15000);
    f.store.availability(true);
    const next=f.store.create('text',30);f.store.pay(next.id,'success');f.store.accept(next.id);
    f.store.ready(next.id,'customer'); f.advance(30000);f.store.sweep();
    assert.equal(f.store.get(next.id).refund,35000);
  } finally { f.close(); }
});
test('messages are durable and idempotent; closed sessions reject new messages',()=>{
  const f=fixture();try {
    const b=f.active();const id=randomUUID();
    f.store.send(b.id,'customer',id,'Hello');f.store.send(b.id,'customer',id,'Hello');
    f.store.send(b.id,'bestie',randomUUID(),'I am listening.');
    assert.equal(f.store.messages(b.id).length,2);
    assert.throws(()=>f.store.send(b.id,'bestie',id,'Hello'));
    f.advance(600001);f.store.sweep();
    assert.equal(f.store.get(b.id).status,'ended');
    assert.throws(()=>f.store.send(b.id,'customer',randomUUID(),'too late'));
  } finally { f.close(); }
});
test('extension retries add time once; failed payment adds nothing; late success refunds',()=>{
  const f=fixture();try {
    const b=f.active();const e=f.store.extend(b.id);
    assert.equal(f.store.extend(b.id).id,e.id);
    f.store.payExtension(b.id,e.id,'failure');assert.equal(f.store.get(b.id).ends,b.ends);
    f.store.payExtension(b.id,e.id,'success');f.store.payExtension(b.id,e.id,'success');
    assert.equal(f.store.get(b.id).ends,b.ends!+600000);
    const late=f.store.extend(b.id);
    f.advance(1200001);
    assert.equal(f.store.payExtension(b.id,late.id,'success').status,'simulated_refunded');
    assert.equal(f.store.get(b.id).ends,b.ends!+600000);
    assert.equal(f.store.payExtension(b.id,late.id,'success').status,'simulated_refunded');
  } finally { f.close(); }
});
test('listener disconnection refunds remaining time and cancels pending extension safely',()=>{
  const f=fixture();try {
    const b=f.active(); const e=f.store.extend(b.id);
    f.advance(60000);f.store.sweep();
    assert.equal(f.store.get(b.id).status,'ended');
    assert.equal(f.store.get(b.id).refund,13500);
    assert.equal(f.store.payExtension(b.id,e.id,'success').status,'simulated_refunded');
  } finally { f.close(); }
});
test('paid cancellation refunds; unpaid cancellation does not; cancelled booking cannot reactivate',()=>{
  const f=fixture();try {
    const a=f.store.create('text',10);assert.equal(f.store.cancel(a.id).refund,0);
    assert.throws(()=>f.store.pay(a.id,'success'));
    const b=f.store.create('text',30);f.store.pay(b.id,'success');
    assert.equal(f.store.cancel(b.id).refund,35000);
    assert.equal(f.store.pay(b.id,'success').status,'cancelled');
  } finally { f.close(); }
});
test('SQLite restart preserves messages, payments and the original end time',()=>{
  const directory=mkdtempSync(join(tmpdir(),'halobestie-'));const path=join(directory,'test.sqlite');
  let s=new Store(path,()=>1000000);
  try {
    s.availability(true);const b=s.create('text',10);s.pay(b.id,'success');s.accept(b.id);s.ready(b.id,'customer');s.ready(b.id,'bestie');
    s.send(b.id,'customer',randomUUID(),'Persist me');const end=s.get(b.id).ends;s.db.close();
    s=new Store(path,()=>1001000);
    assert.equal(s.snapshot('customer').booking?.ends,end);assert.equal(s.messages(b.id)[0].body,'Persist me');
  } finally {s.db.close();rmSync(directory,{recursive:true,force:true});}
});
test('HTTP role checks, validation and full client-to-client flow',async()=>{
  const f=fixture();const server=createApp(f.store).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert(address && typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}/api`;
  const call=(path:string,role:string,body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer demo-'+role,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  try {
    assert.equal((await fetch(base+'/state')).status,401);
    assert.equal((await call('/availability','customer',{online:true})).status,403);
    assert.equal((await call('/bookings','customer',{service:'text',minutes:1})).status,400);
    await call('/availability','bestie',{online:true});
    const b=await (await call('/bookings','customer',{service:'text',minutes:10,price:1})).json();
    assert.equal(b.price,15000);
    await call(`/bookings/${b.id}/pay`,'customer',{outcome:'success'});
    await call(`/bookings/${b.id}/accept`,'bestie',{});
    await call(`/bookings/${b.id}/ready`,'customer',{});await call(`/bookings/${b.id}/ready`,'bestie',{});
    assert.equal((await call(`/bookings/${b.id}/messages`,'customer',{id:randomUUID(),body:'Hi'})).status,201);
    const state=await (await call('/state','bestie')).json();
    assert.equal(state.messages[0].body,'Hi');assert.equal(state.booking.nickname,'Moonlight');
    assert(!JSON.stringify(state).includes('email'));assert(!JSON.stringify(state).includes('phone'));
    const e=await(await call(`/bookings/${b.id}/extensions`,'customer',{})).json();
    assert.equal((await call(`/bookings/${b.id}/extensions/${e.id}/pay`,'bestie',{outcome:'success'})).status,403);
    const applied=await(await call(`/bookings/${b.id}/extensions/${e.id}/pay`,'customer',{outcome:'success'})).json();
    assert.equal(applied.status,'applied');
  } finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));f.close();}
});

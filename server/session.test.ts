import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store';
import { createApp } from './app';
import { SandboxPaymentAdapter } from './payments';
import { DatabaseSync } from 'node:sqlite';

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
    assert.equal(f.store.pay(a.id,'success').status,'cancelled');
    assert.equal(f.store.get(a.id).refund,15000);
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
  const call=(path:string,role:string,body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-'+role,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  try {
    assert.equal((await fetch(base+'/state')).status,401);
    assert.equal((await call('/availability','customer',{online:true})).status,403);
    const quote=await(await call('/quote?service=voice&minutes=30','customer')).json();
    assert.equal(quote.amount,65000);assert.equal(quote.currency,'IDR');
    assert.equal((await call('/quote?service=text&minutes=1','customer')).status,400);
    assert.equal((await call('/quote?service=text&minutes=10','bestie')).status,403);
    assert.equal((await call('/profile','bestie',{nickname:'Sunrise'})).status,403);
    assert.equal((await call('/profile','customer',{nickname:'email@example.com'})).status,400);
    assert.equal((await call('/profile','customer',{nickname:'Sunrise'})).status,200);
    assert.equal((await call('/bookings','customer',{service:'text',minutes:1})).status,400);
    await call('/availability','bestie',{online:true});
    const b=await (await call('/bookings','customer',{service:'text',minutes:10,price:1})).json();
    assert.equal(b.price,15000);
    assert.equal(b.nickname,'Sunrise');
    const failedEvent=randomUUID();
    await call(`/bookings/${b.id}/pay`,'customer',{outcome:'failure',eventId:failedEvent});
    assert.equal((await call(`/bookings/${b.id}/pay`,'customer',{outcome:'success',eventId:failedEvent})).status,409);
    const successEvent=randomUUID();
    const responses=await Promise.all(Array.from({length:5},()=>call(`/bookings/${b.id}/pay`,'customer',{outcome:'success',eventId:successEvent})));
    assert(responses.every(r=>r.status===200));
    await call(`/bookings/${b.id}/accept`,'bestie',{});
    await call(`/bookings/${b.id}/ready`,'customer',{});await call(`/bookings/${b.id}/ready`,'bestie',{});
    assert.equal((await call(`/bookings/${b.id}/messages`,'customer',{id:randomUUID(),body:'Hi'})).status,201);
    const state=await (await call('/state','bestie')).json();
    assert.equal(state.messages[0].body,'Hi');assert.equal(state.booking.nickname,'Sunrise');
    assert(!JSON.stringify(state).includes('email'));assert(!JSON.stringify(state).includes('phone'));
    const e=await(await call(`/bookings/${b.id}/extensions`,'customer',{})).json();
    assert.equal((await call(`/bookings/${b.id}/extensions/${e.id}/pay`,'bestie',{outcome:'success'})).status,403);
    const applied=await(await call(`/bookings/${b.id}/extensions/${e.id}/pay`,'customer',{outcome:'success'})).json();
    assert.equal(applied.status,'applied');
    assert.equal((await call(`/bookings/${b.id}/rating`,'customer',{stars:5,comment:''})).status,409);
    assert.equal((await call(`/bookings/${b.id}/end`,'bestie',{})).status,200);
    assert.equal((await call(`/bookings/${b.id}/rating`,'bestie',{stars:5,comment:''})).status,403);
    assert.equal((await call(`/bookings/${b.id}/rating`,'customer',{stars:6,comment:''})).status,400);
    assert.equal((await call(`/bookings/${b.id}/rating`,'customer',{stars:5,comment:'Thank you'})).status,200);
    const ratedState=await(await call('/state?bookingId='+b.id,'customer')).json();
    assert.equal(ratedState.rating.stars,5);
    assert.equal(ratedState.activity.averageRating,5);
  } finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));f.close();}
});
test('nickname changes apply to future bookings; hour-long sessions use server prices',()=>{
  const f=fixture();try {
    f.store.updateNickname('Sunrise');
    const b=f.store.create('text',60);
    assert.equal(b.price,65000);assert.equal(b.nickname,'Sunrise');
    f.store.updateNickname('Starlight');assert.equal(f.store.get(b.id).nickname,'Sunrise');
    f.store.cancel(b.id);
    const voice=f.store.create('voice',60);assert.equal(voice.price,120000);assert.equal(voice.nickname,'Starlight');
  } finally {f.close();}
});
test('decline refunds once and releases the reservation',()=>{
  const f=fixture();try {
    const b=f.store.create('text',10);f.store.pay(b.id,'success');
    assert.equal(f.store.decline(b.id).refund,15000);
    assert.equal(f.store.decline(b.id).refund,15000);
    assert.throws(()=>f.store.accept(b.id));
    assert.equal(f.store.create('text',10).status,'unpaid');
  } finally {f.close();}
});
test('early ending applies role-specific refunds and freezes supported minutes',()=>{
  const f=fixture();try {
    const b=f.active();f.advance(60000);f.store.heartbeat();
    assert.equal(f.store.finish(b.id,'customer').refund,0);
    assert.equal(f.store.snapshot('customer').activity.minutes,1);
    f.advance(60000);assert.equal(f.store.snapshot('customer').activity.minutes,1);
    const next=f.active();f.advance(60000);f.store.heartbeat();
    const ended=f.store.finish(next.id,'bestie');assert.equal(ended.refund,13500);
    assert.equal(f.store.finish(next.id,'bestie').refund,13500);
    assert.throws(()=>f.store.send(next.id,'customer',randomUUID(),'too late'));
    f.store.rate(next.id,4,'Helpful');
    const snapshot=f.store.snapshot('customer',next.id);
    assert.equal(snapshot.rating?.stars,4);assert.equal(snapshot.activity.averageRating,4);
    assert.equal(snapshot.activity.completed,2);assert.equal(snapshot.activity.minutes,2);
    f.store.create('text',10);
    assert.equal(f.store.snapshot('customer',next.id).booking?.id,next.id);
    assert.equal(f.store.snapshot('customer').history.length,2);
  } finally {f.close();}
});
test('booking creation and settlement are retry-safe and keep the selected method',()=>{
  const f=fixture();try {
    const requestId=randomUUID();
    const b=f.store.create('text',10,'EWALLET',requestId);
    assert.equal(f.store.create('text',10,'EWALLET',requestId).id,b.id);
    assert.throws(()=>f.store.create('text',30,'EWALLET',requestId));
    const failure=randomUUID();f.store.pay(b.id,'failure',failure);f.store.pay(b.id,'failure',failure);
    assert.equal(f.store.snapshot('customer').payments[0].status,'failed');
    const success=randomUUID();const paid=f.store.pay(b.id,'success',success);f.advance(1000);
    assert.equal(f.store.pay(b.id,'success',success).deadline,paid.deadline);
    assert.equal(f.store.pay(b.id,'failure').payment,'paid');
    const receipt=f.store.snapshot('customer').payments;
    assert.equal(receipt.length,1);assert.equal(receipt[0].method,'EWALLET');assert.equal(receipt[0].currency,'IDR');
    assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM payment_events').get() as {n:number}).n,2);
  } finally {f.close();}
});
test('matching reserves only an online listener and releases it after cancellation',()=>{
  const f=fixture();try {
    const b=f.store.create('voice',10);f.store.pay(b.id,'success');
    assert.equal(f.store.snapshot('customer').reservedBookingId,null);
    assert.throws(()=>f.store.accept(b.id));
    f.store.availability(true);assert.equal(f.store.snapshot('customer').reservedBookingId,b.id);
    f.store.accept(b.id);assert.equal(f.store.get(b.id).started,null);
    f.advance(30000);f.store.sweep();
    assert.equal(f.store.get(b.id).refund,25000);assert.equal(f.store.listener().reservedBookingId,null);
    assert.equal(f.store.snapshot('customer').refunds.length,1);
    assert.equal(f.store.snapshot('bestie').payments.length,0);
    assert.equal(f.store.snapshot('bestie').refunds.length,0);
  } finally {f.close();}
});
test('refunds use each purchased time block, including fully unused extensions',()=>{
  const f=fixture();try {
    f.store.availability(true);const b=f.store.create('text',30);f.store.pay(b.id,'success');
    f.store.accept(b.id);f.store.ready(b.id,'customer');f.store.ready(b.id,'bestie');
    const e=f.store.extend(b.id);f.store.payExtension(b.id,e.id,'success');
    f.advance(20*60000);f.store.heartbeat();
    assert.equal(f.store.finish(b.id,'bestie').refund,26667);
    const refunds=f.store.snapshot('customer').refunds;
    assert.deepEqual(refunds.map(r=>r.amount),[11667,15000]);
    assert(refunds.every(r=>r.status==='completed'));
    f.store.finish(b.id,'bestie');assert.equal(f.store.snapshot('customer').refunds.length,2);
  } finally {f.close();}
});
test('a late sweep refunds from the disconnect deadline rather than the restart time',()=>{
  const f=fixture();try {
    const b=f.active();f.advance(15*60000);f.store.sweep();
    assert.equal(f.store.get(b.id).closedAt,b.started!+60000);
    assert.equal(f.store.get(b.id).refund,13500);
    assert.equal(f.store.snapshot('customer').activity.minutes,1);
  } finally {f.close();}
});
test('normal expiry closes access without a refund when Bestie stays connected',()=>{
  const f=fixture();try {
    const b=f.active();
    for(let i=0;i<10;i++){f.advance(60000);f.store.heartbeat();f.store.sweep();}
    assert.equal(f.store.get(b.id).status,'ended');assert.equal(f.store.get(b.id).closedAt,b.ends);
    assert.equal(f.store.get(b.id).refund,0);assert.equal(f.store.snapshot('customer').refunds.length,0);
    assert.throws(()=>f.store.send(b.id,'customer',randomUUID(),'Too late'));
    assert.equal(f.store.snapshot('customer').booking?.ends,b.ends);
  } finally {f.close();}
});
test('refund failures remain durable, retry with the same key, and stop after completion',()=>{
  let time=1000000;let calls=0;const keys:string[]=[];
  class RetryingAdapter extends SandboxPaymentAdapter {
    refund(amount:number,key?:string) {
      calls++;keys.push(key!);
      if(calls===1) throw new Error('Temporary provider error');
      return super.refund(amount);
    }
  }
  const s=new Store(':memory:',()=>time,new RetryingAdapter());
  try {
    const b=s.create('text',10);s.pay(b.id,'success');time+=30000;s.sweep();
    assert.equal(s.get(b.id).status,'cancelled');assert.equal(s.get(b.id).payment,'refund_pending');
    assert.equal(s.snapshot('customer').refunds[0].status,'failed');
    time+=5000;s.sweep();assert.equal(s.get(b.id).payment,'simulated_refunded');
    assert.equal(s.snapshot('customer').refunds[0].status,'completed');assert.equal(calls,2);
    assert.equal(keys[0],keys[1]);time+=5000;s.sweep();assert.equal(calls,2);
  } finally {s.close();}
});
test('ledger receipts and refunds persist without inventing a refund on restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'halobestie-ledger-'));const path=join(dir,'test.sqlite');
  let time=1000000;let s=new Store(path,()=>time);
  try {
    s.availability(true);const b=s.create('text',10,'VIRTUAL_ACCOUNT');s.pay(b.id,'success');s.accept(b.id);s.ready(b.id,'customer');s.ready(b.id,'bestie');
    const e=s.extend(b.id);s.payExtension(b.id,e.id,'success');
    time+=12*60000;s.heartbeat();s.finish(b.id,'bestie');
    assert.equal(s.get(b.id).refund,12000);assert.equal(s.snapshot('customer').refunds.length,1);
    s.close();s=new Store(path,()=>time);
    const state=s.snapshot('customer');assert.equal(state.payments.length,2);
    assert.equal(state.payments[0].method,'VIRTUAL_ACCOUNT');assert.equal(state.refunds.length,1);assert.equal(state.refunds[0].amount,12000);
  } finally {s.close();rmSync(dir,{recursive:true,force:true});}
});
test('legacy databases migrate refund totals without replaying transfers',()=>{
  const dir=mkdtempSync(join(tmpdir(),'halobestie-legacy-'));const path=join(dir,'test.sqlite');
  let time=1000000;let s=new Store(path,()=>time);
  try {
    s.availability(true);const b=s.create('text',10);s.pay(b.id,'success');s.accept(b.id);s.ready(b.id,'customer');s.ready(b.id,'bestie');
    const e=s.extend(b.id);s.payExtension(b.id,e.id,'success');time+=60000;s.heartbeat();s.finish(b.id,'bestie');
    const expected=s.get(b.id).refund;s.close();
    const legacy=new DatabaseSync(path);
    legacy.exec('DROP TABLE refunds; DROP TABLE payment_events; DROP TABLE payments; DROP TABLE booking_requests; DROP TABLE ledger_migrations;');legacy.close();
    let calls=0;
    class CountAdapter extends SandboxPaymentAdapter {refund(amount:number){calls++;return super.refund(amount);}}
    s=new Store(path,()=>time,new CountAdapter());
    const state=s.snapshot('customer');
    assert.equal(state.refunds.reduce((sum,r)=>sum+r.amount,0),expected);
    for(const refund of state.refunds) assert(refund.amount<=state.payments.find(p=>p.id===refund.paymentId)!.amount);
    assert.equal(calls,0);
  } finally {s.close();rmSync(dir,{recursive:true,force:true});}
});
test('extension settlement refunds instead of adding time when Bestie is unavailable',()=>{
  const f=fixture();try {
    const b=f.active();const e=f.store.extend(b.id);f.advance(16000);
    assert.equal(f.store.get(b.id).status,'active');
    assert.equal(f.store.payExtension(b.id,e.id,'success').status,'simulated_refunded');
    assert.equal(f.store.get(b.id).ends,b.ends);
    const receipt=f.store.snapshot('customer');
    assert.equal(receipt.refunds[0].amount,15000);assert.equal(receipt.refunds[0].status,'completed');
    f.store.payExtension(b.id,e.id,'success');assert.equal(f.store.snapshot('customer').refunds.length,1);
  } finally {f.close();}
});

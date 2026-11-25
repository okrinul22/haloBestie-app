import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Booking, Message, Extension, Role, Service, Snapshot, PaymentMethod } from '../shared/types';
import { PRICES } from '../shared/types';
import { SandboxPaymentAdapter, type PaymentAdapter } from './payments';
import { Ledger } from './ledger';

export class DomainError extends Error { constructor(message: string, public status = 409) { super(message); } }
export class Store {
  db: DatabaseSync;
  ledger: Ledger;
  constructor(path: string, private now = () => Date.now(), private payments: PaymentAdapter = new SandboxPaymentAdapter()) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS listener (id INTEGER PRIMARY KEY, online INTEGER NOT NULL, heartbeat INTEGER NOT NULL);
      INSERT OR IGNORE INTO listener (id,online,heartbeat) VALUES (1,0,0);
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY, service TEXT NOT NULL, minutes INTEGER NOT NULL, price INTEGER NOT NULL,
        status TEXT NOT NULL, payment TEXT NOT NULL, created INTEGER NOT NULL, deadline INTEGER,
        started INTEGER, ends INTEGER, customerReady INTEGER NOT NULL DEFAULT 0,
        bestieReady INTEGER NOT NULL DEFAULT 0, reason TEXT, refund INTEGER NOT NULL DEFAULT 0,
        nickname TEXT NOT NULL DEFAULT 'Moonlight');
      CREATE UNIQUE INDEX IF NOT EXISTS single_open_booking ON bookings ((1))
        WHERE status IN ('unpaid','matching','connecting','active');
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, bookingId TEXT NOT NULL REFERENCES bookings(id),
        role TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, bookingId TEXT NOT NULL REFERENCES bookings(id),
        minutes INTEGER NOT NULL, price INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY, nickname TEXT NOT NULL);
      INSERT OR IGNORE INTO profile VALUES (1,'Moonlight');
      CREATE TABLE IF NOT EXISTS ratings (bookingId TEXT PRIMARY KEY REFERENCES bookings(id), stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), comment TEXT NOT NULL);
    `);
    const columns=this.db.prepare('PRAGMA table_info(bookings)').all() as {name:string}[];
    if(!columns.some(c=>c.name==='closedAt')) this.db.exec('ALTER TABLE bookings ADD COLUMN closedAt INTEGER');
    if(!(this.db.prepare('PRAGMA table_info(listener)').all() as {name:string}[]).some(c=>c.name==='reservedBookingId')) this.db.exec('ALTER TABLE listener ADD COLUMN reservedBookingId TEXT');
    this.ledger=new Ledger(this.db,this.now,this.payments);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string): Booking {
    const b = this.db.prepare('SELECT * FROM bookings WHERE id=?').get(id) as unknown as Booking | undefined;
    if (!b) throw new DomainError('Booking not found', 404);
    return b;
  }
  listener() { return this.db.prepare('SELECT * FROM listener WHERE id=1').get() as { online: number; heartbeat: number; reservedBookingId:string|null }; }
  online() { const l = this.listener(); return !!l.online && this.now() - l.heartbeat < 15000; }
  reserve() {
    this.db.prepare("UPDATE listener SET reservedBookingId=NULL WHERE reservedBookingId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bookings WHERE id=listener.reservedBookingId AND status IN ('matching','connecting','active'))").run();
    if(!this.online()) return;
    const b=this.db.prepare("SELECT id FROM bookings WHERE status='matching' ORDER BY created,rowid LIMIT 1").get() as {id:string}|undefined;
    if(b) this.db.prepare('UPDATE listener SET reservedBookingId=? WHERE id=1 AND reservedBookingId IS NULL').run(b.id);
  }
  fullRefund(b: Booking, reason:string) {
    const refund=this.ledger.refund(b.id,b.price,reason);
    return refund?.status==='completed'?'simulated_refunded':'refund_pending';
  }
  refundUnused(b:Booking,at:number) {
    let cursor=b.started!;
    let total=0;
    const purchases=[{id:b.id,minutes:b.minutes,price:b.price},...this.extensions(b.id).filter(e=>e.status==='applied')];
    for(const purchase of purchases) {
      const duration=purchase.minutes*60000;
      const unused=Math.min(duration,Math.max(0,cursor+duration-at));
      const amount=Math.ceil(purchase.price*unused/duration);
      if(amount>0) this.ledger.refund(purchase.id,amount,'Unused session time');
      total+=amount;cursor+=duration;
    }
    return total;
  }
  sweep() {
    this.transaction(() => {
      const bookings = this.db.prepare("SELECT * FROM bookings WHERE status IN ('matching','connecting','active')").all() as unknown as Booking[];
      for (const b of bookings) {
        // Compare deadlines, not poll order: a restart must retain the correct disconnect refund.
        const disconnectedAt=Math.max(b.started??0,this.listener().heartbeat)+60000;
        if(b.status==='active' && disconnectedAt<=this.now() && disconnectedAt<b.ends!) {
          const refund=this.refundUnused(b,disconnectedAt);
          this.db.prepare("UPDATE bookings SET status='ended',reason='Bestie disconnected · unused time refund requested',refund=?,closedAt=? WHERE id=?").run(refund,disconnectedAt,b.id);
        } else if (b.status === 'active' && b.ends! <= this.now()) {
          this.db.prepare("UPDATE bookings SET status='ended',reason='Time completed',closedAt=ends WHERE id=?").run(b.id);
        } else if (b.status !== 'active' && b.deadline! <= this.now()) {
          const payment=this.fullRefund(b,'Session did not start');
          this.db.prepare("UPDATE bookings SET status='cancelled',payment=?,refund=price,reason=?,closedAt=? WHERE id=?")
            .run(payment,b.status === 'matching' ? 'No Bestie accepted within 30 seconds' : 'Participants did not connect in time',this.now(),b.id);
        }
      }
      this.ledger.retry();
      this.db.prepare("UPDATE bookings SET payment='simulated_refunded' WHERE status='cancelled' AND payment='refund_pending' AND EXISTS (SELECT 1 FROM refunds WHERE paymentId='booking:'||bookings.id AND status='completed')").run();
      this.db.prepare("UPDATE extensions SET status='simulated_refunded' WHERE status='refund_pending' AND EXISTS (SELECT 1 FROM refunds WHERE paymentId='extension:'||extensions.id AND status='completed')").run();
      this.reserve();
    });
  }
  availability(online: boolean) {
    this.sweep();
    const active = this.db.prepare("SELECT id FROM bookings WHERE status IN ('connecting','active')").get();
    if (active && !online) throw new DomainError('Finish the current session before going offline');
    this.db.prepare('UPDATE listener SET online=?,heartbeat=? WHERE id=1').run(online ? 1 : 0, this.now());
    if(!online) this.db.prepare('UPDATE listener SET reservedBookingId=NULL WHERE id=1').run();
    this.reserve();
  }
  heartbeat() { this.db.prepare('UPDATE listener SET heartbeat=? WHERE id=1 AND online=1').run(this.now()); }
  nickname() { return (this.db.prepare('SELECT nickname FROM profile WHERE id=1').get() as {nickname:string}).nickname; }
  updateNickname(nickname: string) {
    this.db.prepare('UPDATE profile SET nickname=? WHERE id=1').run(nickname);
    return {nickname};
  }
  create(service: Service, minutes: 10 | 30 | 60, method:PaymentMethod='QRIS', requestId?:string) {
    this.sweep();
    return this.transaction(() => {
      if(requestId) {
        const previous=this.db.prepare('SELECT bookingId FROM booking_requests WHERE id=?').get(requestId) as {bookingId:string}|undefined;
        if(previous) {
          const b=this.get(previous.bookingId);
          if(b.service!==service||b.minutes!==minutes||this.ledger.payment(b.id).method!==method) throw new DomainError('Booking request ID was used with different details');
          return b;
        }
      }
      if (this.db.prepare("SELECT id FROM bookings WHERE status IN ('unpaid','matching','connecting','active')").get()) throw new DomainError('Finish or cancel your current booking first');
      const id = randomUUID();
      this.db.prepare("INSERT INTO bookings (id,service,minutes,price,status,payment,created,nickname) VALUES (?,?,?,?,'unpaid','pending',?,?)")
        .run(id,service,minutes,PRICES[service][minutes],this.now(),this.nickname());
      this.ledger.ensure(id,id,'booking',PRICES[service][minutes],method);
      if(requestId) this.db.prepare('INSERT INTO booking_requests VALUES (?,?)').run(requestId,id);
      return this.get(id);
    });
  }
  pay(id: string, outcome: 'success' | 'failure', eventId?:string) {
    this.sweep();
    return this.transaction(() => {
      const b = this.get(id);
      if (this.ledger.payment(id).status==='paid') return b;
      const payment = this.ledger.settle(id,outcome,eventId);
      if(b.status==='cancelled') {
        if(payment==='paid') {
          const refunded=this.fullRefund(b,'Payment arrived after cancellation');
          this.db.prepare('UPDATE bookings SET payment=?,refund=price WHERE id=?').run(refunded,id);
        }
        return this.get(id);
      }
      if (b.status !== 'unpaid') throw new DomainError('Booking is closed');
      this.db.prepare('UPDATE bookings SET payment=?,status=?,deadline=? WHERE id=?')
        .run(payment, payment === 'paid' ? 'matching' : 'unpaid', payment === 'paid' ? this.now()+30000 : null,id);
      this.reserve();
      return this.get(id);
    });
  }
  cancel(id: string) {
    this.sweep();
    return this.transaction(() => {
      const b=this.get(id);
      if(b.status==='cancelled') return b;
      if (!['unpaid','matching'].includes(b.status)) throw new DomainError('This booking cannot be cancelled now');
      const payment=b.payment === 'paid' ? this.fullRefund(b,'Customer cancelled') : b.payment;
      this.db.prepare("UPDATE bookings SET status='cancelled',reason='Customer cancelled',refund=?,payment=? WHERE id=?")
        .run(b.payment === 'paid' ? b.price : 0,payment,id);
      this.reserve();
      return this.get(id);
    });
  }
  accept(id: string) {
    this.sweep();
    return this.transaction(() => {
      const b=this.get(id);
      if (b.status === 'connecting' || b.status === 'active') return b;
      this.reserve();
      if (b.status !== 'matching' || !this.online() || this.listener().reservedBookingId!==id) throw new DomainError('Go online and accept your reserved booking');
      this.db.prepare("UPDATE bookings SET status='connecting',deadline=? WHERE id=?").run(this.now()+30000,id);
      return this.get(id);
    });
  }
  decline(id: string) {
    this.sweep();
    return this.transaction(() => {
      const b=this.get(id);
      if(b.status==='cancelled' && b.reason==='Bestie unavailable') return b;
      if(b.status!=='matching') throw new DomainError('Only a waiting booking can be declined');
      const payment=this.fullRefund(b,'Bestie unavailable');
      this.db.prepare("UPDATE bookings SET status='cancelled',payment=?,refund=price,reason='Bestie unavailable' WHERE id=?").run(payment,id);
      this.reserve();
      return this.get(id);
    });
  }
  finish(id: string, role: Role) {
    this.sweep();
    return this.transaction(() => {
      const b=this.get(id);
      if(b.status==='ended') return b;
      if(b.status!=='active') throw new DomainError('Only an active session can be ended');
      const refund=role==='bestie' ? this.refundUnused(b,this.now()) : 0;
      this.db.prepare("UPDATE bookings SET status='ended',reason=?,refund=?,closedAt=? WHERE id=?")
        .run(role==='bestie'?'Bestie ended the session · unused time refund requested':'Customer ended the session',refund,this.now(),id);
      this.reserve();
      return this.get(id);
    });
  }
  rate(id: string, stars: number, comment: string) {
    this.sweep();
    if(this.get(id).status!=='ended') throw new DomainError('Rate a completed session');
    this.db.prepare('INSERT INTO ratings VALUES (?,?,?) ON CONFLICT(bookingId) DO UPDATE SET stars=excluded.stars,comment=excluded.comment').run(id,stars,comment);
    return {bookingId:id,stars,comment};
  }
  ready(id: string, role: Role) {
    this.sweep();
    return this.transaction(() => {
      const b=this.get(id);
      if (b.status === 'active') return b;
      if (b.status !== 'connecting') throw new DomainError('Wait for the Bestie to accept');
      this.db.prepare(`UPDATE bookings SET ${role === 'customer' ? 'customerReady' : 'bestieReady'}=1 WHERE id=?`).run(id);
      const updated=this.get(id);
      if (updated.customerReady && updated.bestieReady) {
        this.db.prepare("UPDATE bookings SET status='active',started=?,ends=?,deadline=NULL WHERE id=?").run(this.now(),this.now()+b.minutes*60000,id);
      }
      return this.get(id);
    });
  }
  messages(id: string) { return this.db.prepare('SELECT * FROM messages WHERE bookingId=? ORDER BY created,rowid').all(id) as unknown as Message[]; }
  send(id: string, role: Role, messageId: string, body: string) {
    this.sweep();
    return this.transaction(() => {
      const previous=this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as unknown as Message | undefined;
      if(previous) {
        if(previous.bookingId!==id || previous.role!==role || previous.body!==body) throw new DomainError('Message ID already used');
        return previous;
      }
      if (this.get(id).status !== 'active') throw new DomainError('Session is not active');
      this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(messageId,id,role,body,this.now());
      return this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    });
  }
  extensions(id: string) { return this.db.prepare('SELECT * FROM extensions WHERE bookingId=? ORDER BY rowid').all(id) as unknown as Extension[]; }
  extend(id: string) {
    this.sweep();
    return this.transaction(() => {
      const b=this.get(id);
      if(b.status !== 'active' || !this.online()) throw new DomainError('Extension requires an active session and an available Bestie');
      const pending=this.extensions(id).find(e => e.status === 'pending' || e.status === 'failed');
      if(pending) return pending;
      const extension: Extension={id:randomUUID(),bookingId:id,minutes:10,price:PRICES[b.service][10],status:'pending'};
      this.db.prepare('INSERT INTO extensions VALUES (?,?,?,?,?)').run(extension.id,id,10,extension.price,'pending');
      this.ledger.ensure(id,extension.id,'extension',extension.price,this.ledger.payment(id).method);
      return extension;
    });
  }
  payExtension(id: string, extensionId: string, outcome: 'success' | 'failure', eventId?:string) {
    this.sweep();
    return this.transaction(() => {
      const e=this.extensions(id).find(e => e.id === extensionId);
      if(!e) throw new DomainError('Extension not found',404);
      if(this.ledger.payment(extensionId).status==='paid') return e;
      const b=this.get(id);
      const paid=this.ledger.settle(extensionId,outcome,eventId) === 'paid';
      let status=!paid ? 'failed' : b.status !== 'active'||!this.online() ? 'simulated_refunded' : 'applied';
      if(status === 'simulated_refunded' && this.ledger.refund(extensionId,e.price,b.status==='active'?'Bestie unavailable for extension':'Extension payment arrived after session ended')?.status!=='completed') status='refund_pending';
      if(status === 'applied') this.db.prepare('UPDATE bookings SET ends=ends+? WHERE id=?').run(e.minutes*60000,id);
      this.db.prepare('UPDATE extensions SET status=? WHERE id=?').run(status,e.id);
      return {...e,status};
    });
  }
  snapshot(role: Role, selectedId?: string): Snapshot {
    // Sweep before heartbeat so a returning listener cannot erase a timed-out disconnect.
    this.sweep();
    if(role === 'bestie') this.heartbeat();
    const b=selectedId ? this.get(selectedId) : this.db.prepare('SELECT * FROM bookings ORDER BY created DESC,rowid DESC LIMIT 1').get() as unknown as Booking | undefined;
    if(selectedId && !['ended','cancelled'].includes(b!.status)) throw new DomainError('History is available for closed sessions');
    const visible=role === 'bestie' && b?.status === 'unpaid' ? null : b ?? null;
    const history=this.db.prepare("SELECT * FROM bookings WHERE status IN ('ended','cancelled') ORDER BY created DESC,rowid DESC LIMIT 30").all() as unknown as Booking[];
    const stats=this.db.prepare("SELECT COUNT(*) AS completed FROM bookings WHERE status='ended'").get() as {completed:number};
    const minutes=this.db.prepare("SELECT COALESCE(SUM(MAX(0,MIN(ends,COALESCE(closedAt,ends))-started)/60000.0),0) AS minutes FROM bookings WHERE status='ended' AND started IS NOT NULL").get() as {minutes:number};
    const average=this.db.prepare('SELECT AVG(stars) AS averageRating FROM ratings').get() as {averageRating:number|null};
    const rating=visible ? this.db.prepare('SELECT * FROM ratings WHERE bookingId=?').get(visible.id) as unknown as Snapshot['rating'] : null;
    return {serverNow:this.now(),online:this.online(),booking:visible,messages:visible ? this.messages(visible.id) : [],extensions:visible ? this.extensions(visible.id) : [],nickname:this.nickname(),history,rating:rating??null,activity:{...stats,minutes:Math.round(minutes.minutes),...average},payments:role==='customer'&&visible?this.ledger.payments(visible.id):[],refunds:role==='customer'&&visible?this.ledger.refunds(visible.id):[],reservedBookingId:this.listener().reservedBookingId};
  }
  close() { this.db.close(); }
}

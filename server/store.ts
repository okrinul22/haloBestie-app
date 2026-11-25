import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Booking, Message, Extension, Role, Service, Snapshot, PaymentMethod, PaymentProof, VoiceSignal, VoicePoll } from '../shared/types';
import { PRICES } from '../shared/types';
import { SandboxPaymentAdapter, type PaymentAdapter } from './payments';
import { Ledger } from './ledger';
import { Accounts, type Account } from './auth';

export class DomainError extends Error { constructor(message: string, public status = 409) { super(message); } }
export class Store {
  db: DatabaseSync;
  ledger: Ledger;
  accounts: Accounts;
  private transactionDepth=0;
  lastReconcileAt=0;
  lastReconcileError:string|null=null;
  constructor(path: string, private now = () => Date.now(), private payments: PaymentAdapter = new SandboxPaymentAdapter()) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS listener (id INTEGER PRIMARY KEY, online INTEGER NOT NULL, heartbeat INTEGER NOT NULL);
      INSERT OR IGNORE INTO listener (id,online,heartbeat) VALUES (1,0,0);
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY, service TEXT NOT NULL, minutes INTEGER NOT NULL, price INTEGER NOT NULL,
        status TEXT NOT NULL, payment TEXT NOT NULL, created INTEGER NOT NULL, deadline INTEGER,
        started INTEGER, ends INTEGER, customerReady INTEGER NOT NULL DEFAULT 0,
        bestieReady INTEGER NOT NULL DEFAULT 0, reason TEXT, refund INTEGER NOT NULL DEFAULT 0,
        nickname TEXT NOT NULL DEFAULT 'Moonlight');

      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, bookingId TEXT NOT NULL REFERENCES bookings(id),
        role TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, bookingId TEXT NOT NULL REFERENCES bookings(id),
        minutes INTEGER NOT NULL, price INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY, nickname TEXT NOT NULL);
      INSERT OR IGNORE INTO profile VALUES (1,'Moonlight');
      CREATE TABLE IF NOT EXISTS ratings (bookingId TEXT PRIMARY KEY REFERENCES bookings(id), stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), comment TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_calls (bookingId TEXT PRIMARY KEY REFERENCES bookings(id),callId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_signals (sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,bookingId TEXT NOT NULL REFERENCES bookings(id),callId TEXT NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_presence (bookingId TEXT NOT NULL REFERENCES bookings(id),role TEXT NOT NULL,lastSeen INTEGER NOT NULL,connected INTEGER NOT NULL,PRIMARY KEY(bookingId,role));
    `);
    const columns=this.db.prepare('PRAGMA table_info(bookings)').all() as {name:string}[];
    if(!columns.some(c=>c.name==='closedAt')) this.db.exec('ALTER TABLE bookings ADD COLUMN closedAt INTEGER');
    if(!(this.db.prepare('PRAGMA table_info(listener)').all() as {name:string}[]).some(c=>c.name==='reservedBookingId')) this.db.exec('ALTER TABLE listener ADD COLUMN reservedBookingId TEXT');
    if(!columns.some(c=>c.name==='customerId')) this.db.exec("ALTER TABLE bookings ADD COLUMN customerId TEXT NOT NULL DEFAULT 'legacy-customer'");
    if(!columns.some(c=>c.name==='bestieId')) this.db.exec('ALTER TABLE bookings ADD COLUMN bestieId TEXT');
    this.db.exec(`DROP INDEX IF EXISTS single_open_booking;
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_booking_per_customer ON bookings(customerId) WHERE status IN ('unpaid','matching','connecting','active');
      CREATE UNIQUE INDEX IF NOT EXISTS one_connected_booking_per_bestie ON bookings(bestieId) WHERE status IN ('matching','connecting','active') AND bestieId IS NOT NULL;
      CREATE TABLE IF NOT EXISTS besties (userId TEXT PRIMARY KEY,online INTEGER NOT NULL DEFAULT 0,heartbeat INTEGER NOT NULL DEFAULT 0,reservedBookingId TEXT,lastMatched INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO besties(userId,online,heartbeat,reservedBookingId) SELECT 'legacy-bestie',online,heartbeat,reservedBookingId FROM listener WHERE id=1;
      UPDATE bookings SET bestieId='legacy-bestie' WHERE customerId='legacy-customer' AND bestieId IS NULL AND status IN ('connecting','active','ended');
      CREATE TABLE IF NOT EXISTS customer_profiles (userId TEXT PRIMARY KEY,nickname TEXT NOT NULL);
      INSERT OR IGNORE INTO customer_profiles SELECT 'legacy-customer',nickname FROM profile WHERE id=1;
      CREATE TABLE IF NOT EXISTS blocks (blockerId TEXT NOT NULL,blockedId TEXT NOT NULL,PRIMARY KEY(blockerId,blockedId));
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY,bookingId TEXT NOT NULL REFERENCES bookings(id),actorId TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created INTEGER NOT NULL,UNIQUE(bookingId,actorId));
      CREATE TABLE IF NOT EXISTS support_audit (id TEXT PRIMARY KEY,actorId TEXT NOT NULL,action TEXT NOT NULL,targetId TEXT NOT NULL,created INTEGER NOT NULL);
    `);
    this.accounts=new Accounts(this.db,this.now);
    this.ledger=new Ledger(this.db,this.now,this.payments);
  }
  transaction<T>(fn: () => T): T {
    if(this.transactionDepth)return fn();
    this.db.exec('BEGIN IMMEDIATE');this.transactionDepth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally{this.transactionDepth--;}
  }
  get(id: string): Booking {
    const b = this.db.prepare('SELECT * FROM bookings WHERE id=?').get(id) as unknown as Booking | undefined;
    if (!b) throw new DomainError('Booking not found', 404);
    return b;
  }
  authorize(user:Account,id:string) {
    const b=this.get(id);
    if(user.role==='admin'||(user.role==='customer'&&b.customerId===user.id)||(user.role==='bestie'&&b.bestieId===user.id))return b;
    throw new DomainError('Booking not found',404);
  }
  report(user:Account,id:string,reason:string) {
    const b=this.authorize(user,id);
    if(!b.bestieId)throw new DomainError('A participant must be assigned before reporting');
    this.db.prepare("INSERT OR IGNORE INTO reports(id,bookingId,actorId,reason,created) VALUES (?,?,?,?,?)").run(randomUUID(),id,user.id,reason,this.now());
    return this.db.prepare('SELECT id,status FROM reports WHERE bookingId=? AND actorId=?').get(id,user.id);
  }
  block(user:Account,id:string) {
    const b=this.authorize(user,id);const other=user.role==='customer'?b.bestieId:b.customerId;
    if(!other)throw new DomainError('No participant is assigned');
    this.db.prepare('INSERT OR IGNORE INTO blocks VALUES (?,?)').run(user.id,other);return {ok:true};
  }
  audit(actorId:string,action:string,targetId:string){this.db.prepare('INSERT INTO support_audit VALUES (?,?,?,?,?)').run(randomUUID(),actorId,action,targetId,this.now());}
  backup(path:string){this.db.prepare('VACUUM INTO ?').run(path);}
  listener(userId='legacy-bestie') {
    return this.db.prepare('SELECT * FROM besties WHERE userId=?').get(userId) as {online:number;heartbeat:number;reservedBookingId:string|null}|undefined
      ?? {online:0,heartbeat:0,reservedBookingId:null};
  }
  online(userId='legacy-bestie') {const l=this.listener(userId);return !!l.online&&this.now()-l.heartbeat<15000;}
  paymentProof(id:string): PaymentProof {
    const b=this.get(id);const p=this.ledger.payment(id);
    const refund=this.ledger.refunds(id).find(r=>r.paymentId===p?.id);
    const verified=!!p&&p.status==='paid'&&p.amount===b.price&&p.currency==='IDR'&&p.settledAt!==null&&(!refund||refund.amount<p.amount)&&b.payment==='paid';
    return {verified,receiptNumber:verified?p.id:null,amount:b.price,currency:'IDR',paidAt:verified?p.settledAt:null,mode:'sandbox'};
  }
  requirePayment(b:Booking) {
    if(!this.paymentProof(b.id).verified) throw new DomainError('A verified payment receipt is required before entering the session',402);
  }
  voicePresenceRow(id:string,role:Role) {return this.db.prepare('SELECT * FROM voice_presence WHERE bookingId=? AND role=?').get(id,role) as {lastSeen:number;connected:number}|undefined;}
  voiceConnected(id:string,role:Role) {const p=this.voicePresenceRow(id,role);return !!p?.connected&&this.now()-p.lastSeen<5000;}
  reserve() {
    this.transaction(()=>{
      this.db.prepare("UPDATE besties SET reservedBookingId=NULL WHERE reservedBookingId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id=besties.reservedBookingId AND b.bestieId=besties.userId AND b.status IN ('matching','connecting','active'))").run();
      const waiting=this.db.prepare("SELECT * FROM bookings WHERE status='matching' ORDER BY created,rowid").all() as unknown as Booking[];
      for(const booking of waiting) {
        if(booking.bestieId&&this.online(booking.bestieId))continue;
        if(booking.bestieId){this.db.prepare('UPDATE besties SET reservedBookingId=NULL WHERE userId=?').run(booking.bestieId);this.db.prepare('UPDATE bookings SET bestieId=NULL WHERE id=?').run(booking.id);}
        const bestie=this.db.prepare(`SELECT l.userId FROM besties l LEFT JOIN users u ON u.id=l.userId
          WHERE l.online=1 AND l.heartbeat>? AND l.reservedBookingId IS NULL
          AND ((?='legacy-customer' AND l.userId='legacy-bestie') OR (?<>'legacy-customer' AND u.role='bestie' AND u.approved=1))
          AND NOT EXISTS (SELECT 1 FROM blocks k WHERE (k.blockerId=? AND k.blockedId=l.userId) OR (k.blockerId=l.userId AND k.blockedId=?))
          ORDER BY l.lastMatched,l.userId LIMIT 1`).get(this.now()-15000,booking.customerId,booking.customerId,booking.customerId,booking.customerId) as {userId:string}|undefined;
        if(bestie){this.db.prepare('UPDATE bookings SET bestieId=? WHERE id=?').run(bestie.userId,booking.id);this.db.prepare('UPDATE besties SET reservedBookingId=?,lastMatched=? WHERE userId=?').run(booking.id,this.now(),bestie.userId);}
      }
    });
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
        const lastSeen=b.service==='voice'?(this.voicePresenceRow(b.id,'bestie')?.lastSeen??b.started??0):this.listener(b.bestieId??'legacy-bestie').heartbeat;
        const disconnectedAt=Math.max(b.started??0,lastSeen)+60000;
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
      this.db.prepare("DELETE FROM voice_signals WHERE bookingId IN (SELECT id FROM bookings WHERE status IN ('ended','cancelled'))").run();
    });
    this.lastReconcileAt=this.now();
  }
  availability(online:boolean,userId='legacy-bestie') {
    this.sweep();
    this.transaction(()=>{
      const active=this.db.prepare("SELECT id FROM bookings WHERE bestieId=? AND status IN ('connecting','active')").get(userId);
      if(active&&!online)throw new DomainError('Finish the current session before going offline');
      this.db.prepare('INSERT INTO besties(userId,online,heartbeat) VALUES (?,?,?) ON CONFLICT(userId) DO UPDATE SET online=excluded.online,heartbeat=excluded.heartbeat').run(userId,online?1:0,this.now());
      if(!online)this.db.prepare('UPDATE besties SET reservedBookingId=NULL WHERE userId=?').run(userId);
      this.reserve();
    });
  }
  heartbeat(userId='legacy-bestie'){this.db.prepare('UPDATE besties SET heartbeat=? WHERE userId=? AND online=1').run(this.now(),userId);}
  nickname(userId='legacy-customer') {return (this.db.prepare('SELECT nickname FROM customer_profiles WHERE userId=?').get(userId) as {nickname:string}|undefined)?.nickname??this.accounts.user(userId)?.nickname??'Moonlight';}
  updateNickname(nickname:string,userId='legacy-customer') {
    this.db.prepare('INSERT INTO customer_profiles VALUES (?,?) ON CONFLICT(userId) DO UPDATE SET nickname=excluded.nickname').run(userId,nickname);
    return {nickname};
  }
  create(service: Service, minutes: 10 | 30 | 60, method:PaymentMethod='QRIS', requestId?:string, customerId='legacy-customer') {
    this.sweep();
    return this.transaction(() => {
      if(requestId) {
        const previous=this.db.prepare('SELECT bookingId FROM booking_requests WHERE id=?').get(requestId) as {bookingId:string}|undefined;
        if(previous) {
          const b=this.get(previous.bookingId);
          if(b.customerId!==customerId||b.service!==service||b.minutes!==minutes||this.ledger.payment(b.id).method!==method) throw new DomainError('Booking request ID was used with different details');
          return b;
        }
      }
      if (this.db.prepare("SELECT id FROM bookings WHERE customerId=? AND status IN ('unpaid','matching','connecting','active')").get(customerId)) throw new DomainError('Finish or cancel your current booking first');
      const id = randomUUID();
      this.db.prepare("INSERT INTO bookings (id,service,minutes,price,status,payment,created,nickname,customerId) VALUES (?,?,?,?,'unpaid','pending',?,?,?)")
        .run(id,service,minutes,PRICES[service][minutes],this.now(),this.nickname(customerId),customerId);
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
  accept(id: string, bestieId='legacy-bestie') {
    this.sweep();
    return this.transaction(() => {
      const b=this.get(id);
      this.requirePayment(b);
      if (b.status === 'connecting' || b.status === 'active') return b;
      this.reserve();
      if (b.status !== 'matching' || !this.online(bestieId) || this.listener(bestieId).reservedBookingId!==id || b.bestieId!==bestieId) throw new DomainError('Go online and accept your reserved booking');
      this.db.prepare("UPDATE bookings SET status='connecting',deadline=? WHERE id=?").run(this.now()+(b.service==='voice'?60000:30000),id);
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
      this.requirePayment(b);
      if (b.status === 'active') return b;
      if (b.status !== 'connecting') throw new DomainError('Wait for the Bestie to accept');
      if(b.service==='voice'&&!this.voiceConnected(id,role)) throw new DomainError('Connect your microphone call before starting the timer');
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
      const booking=this.get(id);this.requirePayment(booking);
      if(booking.service==='voice') throw new DomainError('Voice sessions use microphone audio, not text chat');
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
      this.requirePayment(b);
      if(b.status !== 'active' || !this.online(b.bestieId??'legacy-bestie')) throw new DomainError('Extension requires an active session and an available Bestie');
      if(b.service==='voice'&&!this.voiceConnected(id,'bestie')) throw new DomainError('Reconnect the voice call before extending');
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
      let status=!paid ? 'failed' : b.status !== 'active'||!this.online(b.bestieId??'legacy-bestie')||(b.service==='voice'&&!this.voiceConnected(id,'bestie')) ? 'simulated_refunded' : 'applied';
      if(status === 'simulated_refunded' && this.ledger.refund(extensionId,e.price,b.status==='active'?'Bestie unavailable for extension':'Extension payment arrived after session ended')?.status!=='completed') status='refund_pending';
      if(status === 'applied') this.db.prepare('UPDATE bookings SET ends=ends+? WHERE id=?').run(e.minutes*60000,id);
      this.db.prepare('UPDATE extensions SET status=? WHERE id=?').run(status,e.id);
      return {...e,status};
    });
  }
  snapshot(role:Role,selectedId?:string,userId=role==='customer'?'legacy-customer':'legacy-bestie'):Snapshot {
    this.sweep();if(role==='bestie')this.heartbeat(userId);
    const owner=role==='customer'?'customerId':'bestieId';
    const b=selectedId?this.get(selectedId):this.db.prepare(`SELECT * FROM bookings WHERE ${owner}=? ORDER BY created DESC,rowid DESC LIMIT 1`).get(userId) as unknown as Booking|undefined;
    if(b&&b[owner]!==userId)throw new DomainError('Booking not found',404);
    if(selectedId&&!['ended','cancelled'].includes(b!.status))throw new DomainError('History is available for closed sessions');
    const visible=role==='bestie'&&b?.status==='unpaid'?null:b??null;
    const history=this.db.prepare(`SELECT * FROM bookings WHERE ${owner}=? AND status IN ('ended','cancelled') ORDER BY created DESC,rowid DESC LIMIT 30`).all(userId) as unknown as Booking[];
    const stats=this.db.prepare(`SELECT COUNT(*) AS completed,COALESCE(SUM(MAX(0,MIN(ends,COALESCE(closedAt,ends))-started)/60000.0),0) AS minutes FROM bookings WHERE ${owner}=? AND status='ended'`).get(userId) as {completed:number;minutes:number};
    const average=this.db.prepare(`SELECT AVG(r.stars) AS averageRating FROM ratings r JOIN bookings b ON b.id=r.bookingId WHERE b.${owner}=?`).get(userId) as {averageRating:number|null};
    const rating=visible?this.db.prepare('SELECT * FROM ratings WHERE bookingId=?').get(visible.id) as unknown as Snapshot['rating']:null;
    const available=this.db.prepare(`SELECT COUNT(*) AS n FROM besties l LEFT JOIN users u ON u.id=l.userId WHERE l.online=1 AND l.heartbeat>? AND l.reservedBookingId IS NULL AND ((?='legacy-customer' AND l.userId='legacy-bestie') OR (?<>'legacy-customer' AND u.approved=1 AND u.role='bestie')) AND NOT EXISTS (SELECT 1 FROM blocks k WHERE (k.blockerId=? AND k.blockedId=l.userId) OR (k.blockerId=l.userId AND k.blockedId=?))`).get(this.now()-15000,userId,userId,userId,userId) as {n:number};
    return {serverNow:this.now(),online:role==='bestie'?this.online(userId):!!available.n||(!!visible?.bestieId&&['matching','connecting','active'].includes(visible.status)&&this.online(visible.bestieId)),booking:visible,messages:visible?this.messages(visible.id):[],extensions:visible?this.extensions(visible.id):[],nickname:role==='customer'?this.nickname(userId):visible?.nickname??'Customer',history,rating:rating??null,activity:{completed:stats.completed,minutes:Math.round(stats.minutes),...average},payments:role==='customer'&&visible?this.ledger.payments(visible.id):[],refunds:role==='customer'&&visible?this.ledger.refunds(visible.id):[],reservedBookingId:role==='bestie'?this.listener(userId).reservedBookingId:visible?.bestieId?this.listener(visible.bestieId).reservedBookingId:null,paymentProof:visible?this.paymentProof(visible.id):null};
  }
  voiceAccess(id:string) {
    this.sweep();const b=this.get(id);this.requirePayment(b);
    if(b.service!=='voice'||!['connecting','active'].includes(b.status)) throw new DomainError('Voice access is closed or this is a text session');
    return b;
  }
  voiceSignal(id:string,role:Role,signal:VoiceSignal) {
    this.voiceAccess(id);
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT * FROM voice_signals WHERE id=?').get(signal.id) as {bookingId:string;role:string;callId:string;kind:string;payload:string}|undefined;
      const payload=JSON.stringify(signal.payload);
      if(previous) {
        if(previous.bookingId!==id||previous.role!==role||previous.callId!==signal.callId||previous.kind!==signal.kind||previous.payload!==payload) throw new DomainError('Signal ID conflicts with an earlier request');
        return {ok:true};
      }
      const current=this.db.prepare('SELECT callId FROM voice_calls WHERE bookingId=?').get(id) as {callId:string}|undefined;
      if(signal.kind==='offer') {
        if(role!=='customer') throw new DomainError('Only the customer can initiate the voice connection',403);
        if(current?.callId!==signal.callId) {
          this.db.prepare('DELETE FROM voice_signals WHERE bookingId=?').run(id);
          this.db.prepare('UPDATE voice_presence SET connected=0 WHERE bookingId=?').run(id);
          this.db.prepare('INSERT INTO voice_calls VALUES (?,?) ON CONFLICT(bookingId) DO UPDATE SET callId=excluded.callId').run(id,signal.callId);
        }
      } else if(current?.callId!==signal.callId) throw new DomainError('Voice connection changed; reconnect to the current call');
      if(signal.kind==='answer'&&role!=='bestie') throw new DomainError('Only the Bestie can answer',403);
      const count=this.db.prepare('SELECT COUNT(*) AS n FROM voice_signals WHERE bookingId=?').get(id) as {n:number};
      if(count.n>=300) throw new DomainError('Too many voice signals; reconnect',429);
      this.db.prepare('INSERT INTO voice_signals(id,bookingId,callId,role,kind,payload) VALUES (?,?,?,?,?,?)').run(signal.id,id,signal.callId,role,signal.kind,payload);
      return {ok:true};
    });
  }
  voicePoll(id:string,role:Role,after:number): VoicePoll {
    this.voiceAccess(id);
    const current=this.db.prepare('SELECT callId FROM voice_calls WHERE bookingId=?').get(id) as {callId:string}|undefined;
    const rows=this.db.prepare('SELECT id,callId,kind,payload,sequence FROM voice_signals WHERE bookingId=? AND role<>? AND sequence>? ORDER BY sequence').all(id,role,after) as unknown as (Omit<VoiceSignal,'payload'>&{payload:string})[];
    const cursor=(this.db.prepare('SELECT COALESCE(MAX(sequence),?) AS cursor FROM voice_signals WHERE bookingId=?').get(after,id) as {cursor:number}).cursor;
    return {callId:current?.callId??null,cursor,signals:rows.map(s=>({...s,payload:JSON.parse(s.payload)}))};
  }
  voicePresence(id:string,role:Role,callId:string,connected:boolean) {
    this.voiceAccess(id);
    const call=this.db.prepare('SELECT callId FROM voice_calls WHERE bookingId=?').get(id) as {callId:string}|undefined;
    if(call?.callId!==callId) throw new DomainError('Voice connection changed');
    if(connected&&!this.db.prepare("SELECT id FROM voice_signals WHERE bookingId=? AND callId=? AND kind='answer'").get(id,callId)) throw new DomainError('Wait for the other participant to answer');
    const lastSeen=connected?this.now():(this.voicePresenceRow(id,role)?.lastSeen??0);
    this.db.prepare('INSERT INTO voice_presence VALUES (?,?,?,?) ON CONFLICT(bookingId,role) DO UPDATE SET lastSeen=excluded.lastSeen,connected=excluded.connected').run(id,role,lastSeen,connected?1:0);
    return {ok:true};
  }
  close() { this.db.close(); }
}

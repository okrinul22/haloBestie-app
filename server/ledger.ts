import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PaymentMethod, PaymentRecord, RefundRecord } from '../shared/types';
import type { PaymentAdapter } from './payments';
export class PaymentEventConflict extends Error {}

/** Persistent sandbox ledger. Real providers must use an outbox and verified callbacks. */
export class Ledger {
  constructor(private db: DatabaseSync, private now:()=>number, private adapter: PaymentAdapter) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, bookingId TEXT NOT NULL REFERENCES bookings(id), targetId TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), currency TEXT NOT NULL DEFAULT 'IDR',
        method TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, settledAt INTEGER);
      CREATE TABLE IF NOT EXISTS refunds (
        id TEXT PRIMARY KEY, paymentId TEXT NOT NULL UNIQUE REFERENCES payments(id), bookingId TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK(amount>0), status TEXT NOT NULL, reason TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS payment_events (
        id TEXT PRIMARY KEY, targetId TEXT NOT NULL, outcome TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS booking_requests (id TEXT PRIMARY KEY, bookingId TEXT NOT NULL REFERENCES bookings(id));
      CREATE TABLE IF NOT EXISTS ledger_migrations (id TEXT PRIMARY KEY);
    `);
    // Adopt pre-upgrade records without replaying payments or refunds.
    if(!db.prepare("SELECT id FROM ledger_migrations WHERE id='legacy-v1'").get()) {
      db.exec('BEGIN IMMEDIATE');
      try { db.exec(`INSERT OR IGNORE INTO payments (id,bookingId,targetId,kind,amount,currency,method,status,created,settledAt)
      SELECT 'booking:'||id,id,id,'booking',price,'IDR','QRIS',
        CASE WHEN payment IN ('paid','simulated_refunded','refund_pending') THEN 'paid' WHEN payment='failed' THEN 'failed' ELSE 'pending' END,
        created,CASE WHEN payment IN ('paid','simulated_refunded','refund_pending') THEN created ELSE NULL END FROM bookings;
      INSERT OR IGNORE INTO payments (id,bookingId,targetId,kind,amount,currency,method,status,created,settledAt)
      SELECT 'extension:'||e.id,e.bookingId,e.id,'extension',e.price,'IDR','QRIS',
        CASE WHEN e.status IN ('applied','simulated_refunded') THEN 'paid' WHEN e.status='failed' THEN 'failed' ELSE 'pending' END,
        b.created,CASE WHEN e.status IN ('applied','simulated_refunded') THEN b.created ELSE NULL END
        FROM extensions e JOIN bookings b ON b.id=e.bookingId;
      INSERT OR IGNORE INTO refunds (id,paymentId,bookingId,amount,status,reason,attempts,updated)
        WITH allocated AS (
          SELECT p.id,p.bookingId,p.amount,p.created,b.refund,
            COALESCE(SUM(p.amount) OVER (PARTITION BY p.bookingId ORDER BY CASE WHEN p.kind='booking' THEN 0 ELSE 1 END,p.rowid ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS allocatedBefore
          FROM payments p JOIN bookings b ON b.id=p.bookingId
          WHERE p.kind='booking' OR EXISTS (SELECT 1 FROM extensions e WHERE e.id=p.targetId AND e.status='applied')
        )
        SELECT 'legacy:'||id,id,bookingId,MIN(amount,refund-allocatedBefore),'completed','Migrated historical refund allocation',1,created FROM allocated WHERE refund>allocatedBefore;
      INSERT OR IGNORE INTO refunds (id,paymentId,bookingId,amount,status,reason,attempts,updated)
        SELECT 'legacy-extension:'||e.id,'extension:'||e.id,e.bookingId,e.price,'completed','Migrated late extension refund',1,b.created
        FROM extensions e JOIN bookings b ON b.id=e.bookingId WHERE e.status='simulated_refunded';
      INSERT INTO ledger_migrations VALUES ('legacy-v1');
    `); db.exec('COMMIT'); } catch(error) {db.exec('ROLLBACK');throw error;}
    }
  }
  ensure(bookingId:string,targetId:string,kind:'booking'|'extension',amount:number,method:PaymentMethod) {
    this.db.prepare("INSERT OR IGNORE INTO payments VALUES (?,?,?,?,?,'IDR',?,'pending',?,NULL)")
      .run(kind+':'+targetId,bookingId,targetId,kind,amount,method,this.now());
    return this.payment(targetId);
  }
  payment(targetId:string) { return this.db.prepare('SELECT * FROM payments WHERE targetId=?').get(targetId) as unknown as PaymentRecord; }
  settle(targetId:string,outcome:'success'|'failure',eventId?:string) {
    const p=this.payment(targetId);
    const previous=eventId ? this.db.prepare('SELECT * FROM payment_events WHERE id=?').get(eventId) as {targetId:string;outcome:string}|undefined : undefined;
    if(previous && (previous.targetId!==targetId || previous.outcome!==outcome)) throw new PaymentEventConflict('Payment event ID conflicts with an earlier request');
    if(previous || p.status==='paid') return p.status;
    this.db.prepare('INSERT INTO payment_events VALUES (?,?,?,?)').run(eventId??randomUUID(),targetId,outcome,this.now());
    const status=this.adapter.settle(outcome);
    this.db.prepare('UPDATE payments SET status=?,settledAt=? WHERE targetId=?').run(status,status==='paid'?this.now():null,targetId);
    return status;
  }
  refund(targetId:string,amount:number,reason:string) {
    if(amount<=0) return;
    const p=this.payment(targetId);
    if(!p || p.status!=='paid' || amount>p.amount) throw new Error('Refund does not match a paid transaction');
    this.db.prepare("INSERT OR IGNORE INTO refunds (id,paymentId,bookingId,amount,status,reason,updated) VALUES (?,?,?,?,'pending',?,?)")
      .run('refund:'+p.id,p.id,p.bookingId,amount,reason,this.now());
    return this.process('refund:'+p.id);
  }
  process(id:string) {
    const refund=this.db.prepare('SELECT * FROM refunds WHERE id=?').get(id) as unknown as RefundRecord;
    if(!refund || refund.status==='completed') return refund;
    try {
      const result=this.adapter.refund(refund.amount,refund.id);
      const status=result.status==='simulated_refunded'?'completed':result.status;
      this.db.prepare('UPDATE refunds SET status=?,attempts=attempts+1,updated=?,error=? WHERE id=?')
        .run(status,this.now(),status==='failed'?'Sandbox refund failed; retry is scheduled':null,id);
    } catch {
      this.db.prepare("UPDATE refunds SET status='failed',attempts=attempts+1,updated=?,error='Refund adapter unavailable; retry is scheduled' WHERE id=?").run(this.now(),id);
    }
    return this.db.prepare('SELECT * FROM refunds WHERE id=?').get(id) as unknown as RefundRecord;
  }
  retry() {
    const pending=this.db.prepare("SELECT id FROM refunds WHERE status <> 'completed' AND updated<=?").all(this.now()-5000) as {id:string}[];
    for(const r of pending) this.process(r.id);
  }
  payments(bookingId:string) { return this.db.prepare('SELECT * FROM payments WHERE bookingId=? ORDER BY created,rowid').all(bookingId) as unknown as PaymentRecord[]; }
  refunds(bookingId:string) { return this.db.prepare('SELECT * FROM refunds WHERE bookingId=? ORDER BY updated,rowid').all(bookingId) as unknown as RefundRecord[]; }
}

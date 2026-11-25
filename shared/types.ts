export type Role = 'customer' | 'bestie';
export type Service = 'text' | 'voice';
export type Status = 'unpaid' | 'matching' | 'connecting' | 'active' | 'ended' | 'cancelled';
export interface Booking {
  id: string; service: Service; minutes: number; price: number; status: Status;
  payment: string; created: number; deadline: number | null; started: number | null;
  ends: number | null; customerReady: number; bestieReady: number; reason: string | null;
  refund: number; nickname: string; closedAt: number|null;
}
export interface Message { id: string; bookingId: string; role: Role; body: string; created: number }
export interface Extension { id: string; bookingId: string; minutes: number; price: number; status: string }
export type PaymentMethod = 'QRIS' | 'EWALLET' | 'VIRTUAL_ACCOUNT';
export interface PaymentRecord { id: string; bookingId: string; targetId: string; kind: 'booking'|'extension'; amount: number; currency: 'IDR'; method: PaymentMethod; status: 'pending'|'failed'|'paid'; created: number; settledAt: number|null }
export interface RefundRecord { id: string; paymentId: string; bookingId: string; amount: number; status: 'pending'|'failed'|'completed'; reason: string; attempts: number; updated: number; error: string|null }
export interface Quote { service: Service; minutes: 10|30|60; amount: number; currency: 'IDR' }
export interface Rating { bookingId: string; stars: number; comment: string }
export interface Activity { completed: number; minutes: number; averageRating: number | null }
export interface Snapshot {
  serverNow: number; online: boolean; booking: Booking | null; messages: Message[];
  extensions: Extension[]; nickname: string; history: Booking[]; rating: Rating | null; activity: Activity;
  payments: PaymentRecord[]; refunds: RefundRecord[]; reservedBookingId: string|null;
}
export const PRICES = { text: { 10: 15000, 30: 35000, 60: 65000 }, voice: { 10: 25000, 30: 65000, 60: 120000 } } as const;

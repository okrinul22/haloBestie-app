export type Role = 'customer' | 'bestie';
export type Service = 'text' | 'voice';
export type Status = 'unpaid' | 'matching' | 'connecting' | 'active' | 'ended' | 'cancelled';
export interface Booking {
  id: string; service: Service; minutes: number; price: number; status: Status;
  payment: string; created: number; deadline: number | null; started: number | null;
  ends: number | null; customerReady: number; bestieReady: number; reason: string | null;
  refund: number; nickname: string;
}
export interface Message { id: string; bookingId: string; role: Role; body: string; created: number }
export interface Extension { id: string; bookingId: string; minutes: number; price: number; status: string }
export interface Rating { bookingId: string; stars: number; comment: string }
export interface Activity { completed: number; minutes: number; averageRating: number | null }
export interface Snapshot {
  serverNow: number; online: boolean; booking: Booking | null; messages: Message[];
  extensions: Extension[]; nickname: string; history: Booking[]; rating: Rating | null; activity: Activity;
}
export const PRICES = { text: { 10: 15000, 30: 35000, 60: 65000 }, voice: { 10: 25000, 30: 65000, 60: 120000 } } as const;

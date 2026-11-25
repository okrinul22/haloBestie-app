// Replace this adapter with verified provider events before accepting real money.
export interface PaymentAdapter {
  settle(outcome: 'success' | 'failure'): 'paid' | 'failed';
  refund(amount: number, idempotencyKey?: string): { amount: number; status: 'simulated_refunded'|'pending'|'failed' };
}
export class SandboxPaymentAdapter implements PaymentAdapter {
  settle(outcome: 'success' | 'failure') { return outcome === 'success' ? 'paid' as const : 'failed' as const; }
  refund(amount: number) { return { amount, status: 'simulated_refunded' as const }; }
}

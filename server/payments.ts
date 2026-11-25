// Replace this adapter with verified provider events before accepting real money.
export interface PaymentAdapter {
  settle(outcome: 'success' | 'failure'): 'paid' | 'failed';
  refund(amount: number): { amount: number; status: 'simulated_refunded' };
}
export class SandboxPaymentAdapter implements PaymentAdapter {
  settle(outcome: 'success' | 'failure') { return outcome === 'success' ? 'paid' as const : 'failed' as const; }
  refund(amount: number) { return { amount, status: 'simulated_refunded' as const }; }
}

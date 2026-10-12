// The payment provider boundary for buying credits. Pure (no `server-only`) for tests.
//
// STATUS: NO PROVIDER CONFIGURED. Choosing a payment provider (and its account, tax and
// invoicing setup) is an operator decision; until then `getPaymentProvider()` returns
// null: automatic top-up stays off and credits are added by a platform administrator
// against a manual invoice. A provider must charge at most once per idempotency key.

export type ChargeResult =
  | { readonly status: "succeeded"; readonly reference: string }
  | { readonly status: "failed"; readonly code: string };

export interface PaymentProvider {
  readonly name: string;
  /** Charges the workspace's saved payment method for `credits` credits. */
  charge(input: {
    readonly workspaceId: string;
    readonly credits: number;
    readonly idempotencyKey: string;
  }): Promise<ChargeResult>;
}

/** This deployment's payment provider: none yet. */
export function getPaymentProvider(): PaymentProvider | null {
  return null;
}

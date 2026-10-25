// Credit packages a workspace owner can buy by card (Stripe Checkout, test mode only).
// Pure (no `server-only`) for tests.
//
// TEMPORARY, SANDBOX ONLY: the owner kept these prices for Stripe test mode (2026-10-24).
// They are not approved for live payments; real prices need a separate owner decision
// (PAYMENTS_DESIGN.md § 5). The browser only ever sends a package id; the credits, amount
// and currency always come from this table on the server.

export interface CreditPackage {
  readonly id: string;
  readonly credits: number;
  /** Integer minor units (cents) of `currency`. */
  readonly amountMinor: number;
  /** Lower-case ISO 4217, as Stripe reports it. */
  readonly currency: "usd";
}

export const CREDIT_PACKAGES = [
  { id: "credits_500", credits: 500, amountMinor: 1_000, currency: "usd" },
  { id: "credits_2000", credits: 2_000, amountMinor: 3_500, currency: "usd" },
  { id: "credits_5000", credits: 5_000, amountMinor: 8_000, currency: "usd" },
] as const satisfies readonly CreditPackage[];

export type CreditPackageId = (typeof CREDIT_PACKAGES)[number]["id"];

export const CREDIT_PACKAGE_IDS = CREDIT_PACKAGES.map((entry) => entry.id) as [
  CreditPackageId,
  ...CreditPackageId[],
];

/** The package with this id, or null (an unknown id is never priced from input). */
export function findCreditPackage(id: string): CreditPackage | null {
  return CREDIT_PACKAGES.find((entry) => entry.id === id) ?? null;
}

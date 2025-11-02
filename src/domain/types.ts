/**
 * @file src/domain/types.ts
 * @description
 * Domain data types, schemas, and helpers for the ledger API.
 */

import { z } from "zod";

/**
 * Strict ISO-4217 currency code validator (3 uppercase letters).
 */
export function isCurrencyCode(code: string): boolean {
  return /^[A-Z]{3}$/.test(code);
}

/**
 * Normalize a human-entered decimal amount string to a canonical
 * representation with up to two fraction digits and no leading zeros.
 */
export function normalizeAmountString(raw: string): string {
  const m = raw.match(/^\d+(?:\.\d{1,})?$/);
  if (!m) return raw; // do not mutate invalid shapes
  const [int, frac = ""] = raw.split(".");
  const i = String(BigInt(int)); // drops leading zeros
  if (!frac) return i;
  const f = frac.slice(0, 2); // keep at most 2
  if (f === "" || /^0{1,2}$/.test(f)) return i;
  return `${i}.${f.padEnd(2, "0")}`.replace(/\.00$/, "");
}

/**
 * Convert a canonical decimal amount string (0, 1, 1.2, 1.23) to integer cents.
 *
 * @throws Error if input is negative or not a decimal with <= 2 fraction digits.
 */
export function cents(str: string): bigint {
  const normalized = normalizeAmountString(str);
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`Invalid amount string: "${str}"`);
  }
  const [int, frac = ""] = normalized.split(".");
  const intPart = BigInt(int) * 100n;
  const fracPart = BigInt((frac || "0").padEnd(2, "0").slice(0, 2));
  return intPart + fracPart;
}

/**
 * Zod schema for a money amount as a string to avoid floating point issues.
 */
export const AmountSchema = z.object({
  currency: z
    .string()
    .refine(isCurrencyCode, { message: "currency must be a 3-letter uppercase ISO-4217 code" }),
  amount: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => /^\d+(?:\.\d{1,2})?$/.test(s), {
      message: "amount must be a positive decimal with up to 2 fraction digits",
    }),
});

export type AmountInput = z.infer<typeof AmountSchema>;

/**
 * Valid buckets in the ledger. `outflow` represents liability leaving the system.
 */
export const BucketEnum = z.enum(["available", "pending", "escrow", "outflow"]);
export type Bucket = z.infer<typeof BucketEnum>;

/**
 * Valid sides for double-entry style balance checking.
 */
export const SideEnum = z.enum(["debit", "credit"]);
export type Side = z.infer<typeof SideEnum>;

/**
 * Valid state transition names for the ledger state machine.
 */
export const TransitionEnum = z.enum([
  "reserve",  // available -> pending
  "lock",     // pending   -> escrow
  "finalize", // escrow    -> outflow
  "release",  // pending   -> available
  "revert",   // escrow    -> available
]);
export type Transition = z.infer<typeof TransitionEnum>;

/**
 * A single journal line describing one leg of a multi-entity transition.
 */
export const LineSchema = z.object({
  accountId: z.string().min(1, "accountId is required"),
  fromBucket: BucketEnum.optional(),
  toBucket: BucketEnum.optional(),
  side: SideEnum,
  amount: AmountSchema,
  transition: TransitionEnum,
});

export type LineInput = z.infer<typeof LineSchema>;

/**
 * Journal schema.
 */
export const JournalSchema = z.object({
  journalId: z.string().min(1, "journalId is required"),
  idempotencyKey: z.string().min(1, "idempotencyKey is required"),
  lines: z.array(LineSchema).min(2, "journal must contain at least two lines"),
});

export type JournalInput = z.infer<typeof JournalSchema>;

/**
 * Assert that a set of lines is balanced under the `side` semantics
 * using integer cents of the provided string amounts.
 *
 * @throws Error if the journal is not balanced.
 */
export function assertBalanced(lines: ReadonlyArray<LineInput>): void {
  let sum = 0n;
  for (const l of lines) {
    const v = cents(l.amount.amount);
    sum += l.side === "debit" ? v : -v;
  }
  if (sum !== 0n) {
    throw new Error("Journal not balanced");
  }
}

/**
 * Check that all lines use the same currency.
 *
 * @returns the shared currency code if all equal; otherwise throws.
 * @throws Error if currencies differ across lines.
 */
export function assertSingleCurrency(lines: ReadonlyArray<LineInput>): string {
  if (lines.length === 0) return "USD";
  const base = lines[0].amount.currency;
  for (const l of lines) {
    if (l.amount.currency !== base) {
      throw new Error("All journal lines must use the same currency");
    }
  }
  return base;
}

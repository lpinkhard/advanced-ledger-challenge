/**
 * @file src/domain/stateMachine.ts
 * @description
 * Finite state machine for ledger bucket transitions and validation helpers.
 */

import { Bucket, Transition, LineInput } from "./types";

/**
 * Canonical transition rule.
 */
export interface TransitionRule {
  /** Transition verb */
  name: Transition;
  /** Source bucket required for the transition */
  from: Bucket | Bucket[];
  /** Destination bucket required for the transition */
  to: Bucket | Bucket[];
}

/**
 * Exhaustive state graph for supported transitions.
 * Single source of truth.
 */
export const RULES: Record<Transition, TransitionRule> = {
  reserve:  { name: "reserve",  from: "available", to: "pending"  },
  lock:     { name: "lock",     from: ["pending", "available"], to: "escrow" },
  finalize: { name: "finalize", from: ["escrow"],  to: "outflow"  },
  release:  { name: "release",  from: "pending",   to: "available"},
  revert:   { name: "revert",   from: "escrow",    to: "available"},
} as const;

/**
 * Quick adjacency view of the state graph.
 */
export const STATE_GRAPH: Readonly<Record<Bucket, Partial<Record<Transition, Bucket>>>> = {
  available: { reserve: "pending" },
  pending:   { lock: "escrow", release: "available" },
  escrow:    { finalize: "outflow", revert: "available" },
  outflow:   {},
} as const;

/**
 * Retrieve the rule for a given transition. Throws if unknown.
 */
export function getRule(t: Transition): TransitionRule {
  const rule = RULES[t];
  if (!rule) {
    // Narrowly typed safeguard; useful if enums/rules drift at runtime.
    throw new Error(`Unknown transition: ${String(t)}`);
  }
  return rule;
}

function bucketMatches(val: Bucket, expected: Bucket | Bucket[]) {
  return Array.isArray(expected) ? expected.includes(val) : val === expected;
}

/**
 * Validate that a journal line's buckets match the required rule for its transition.
 *
 * @throws {Error} if buckets are missing, invalid, or contradictory.
 */
export function validateTransition(line: LineInput): void {
  const rule = getRule(line.transition);

  // Permit explicit no-op balancing lines (from == to)
  if (line.fromBucket === line.toBucket) return;

  // Presence checks
  if (!line.fromBucket) {
    throw new Error(
      `Missing fromBucket for transition "${rule.name}" (expected "${rule.from}")`
    );
  }
  if (!line.toBucket) {
    throw new Error(
      `Missing toBucket for transition "${rule.name}" (expected "${rule.to}")`
    );
  }

  // Exact match checks to the rule
  if (!bucketMatches(line.fromBucket, rule.from)) {
    throw new Error(
      `Invalid fromBucket "${line.fromBucket}" for transition "${rule.name}" (expected "${Array.isArray(rule.from) ? rule.from.join('" or "') : rule.from}")`
    );
  }
  if (!bucketMatches(line.toBucket, rule.to)) {
    throw new Error(
      `Invalid toBucket "${line.toBucket}" for transition "${rule.name}" (expected "${Array.isArray(rule.to) ? rule.to.join('" or "') : rule.to}")`
    );
  }
}

/**
 * Validate all lines for correct transition bucket usage.
 *
 * @throws {Error} on the first invalid line encountered.
 */
export function validateAllTransitions(lines: ReadonlyArray<LineInput>): void {
  for (const line of lines) validateTransition(line);
}

/**
 * Helper to check if a pair is valid for a given transition.
 *
 * @returns true when pair matches the rule exactly; false otherwise.
 */
export function isValidTransitionBuckets(
  transition: Transition,
  from: Bucket | undefined,
  to: Bucket | undefined
): boolean {
  if (!from || !to) return false;
  const rule = getRule(transition);
  return rule.from === from && rule.to === to;
}

/**
 * Compute bucket deltas for a single line
 */
export function bucketsDelta(
  line: Pick<LineInput, "fromBucket" | "toBucket" | "amount">
): Partial<Record<Bucket, number>> {
  const amt = Number(line.amount.amount);
  if (!Number.isFinite(amt) || amt < 0) {
    throw new Error(`Invalid amount for delta computation: "${line.amount.amount}"`);
  }
  const delta: Partial<Record<Bucket, number>> = {};
  if (line.fromBucket) delta[line.fromBucket] = (delta[line.fromBucket] ?? 0) - amt;
  if (line.toBucket)   delta[line.toBucket]   = (delta[line.toBucket]   ?? 0) + amt;
  return delta;
}

/**
 * Human-readable descriptor of a line's transition.
 */
export function describeLine(line: LineInput): string {
  const from = line.fromBucket ?? "?";
  const to = line.toBucket ?? "?";
  const { currency, amount } = line.amount;
  return `${line.accountId}: ${line.transition} ${from} -> ${to} ${currency} ${amount} (${line.side})`;
}

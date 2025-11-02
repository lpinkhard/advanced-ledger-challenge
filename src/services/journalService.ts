/**
 * @file src/services/journalService.ts
 * @description
 * Journal posting and account history services for the ledger.
 */

import type { Db, ClientSession, WithId, Filter } from "mongodb";
import type { AccountDoc, LedgerEntryDoc, JournalDoc, OutboxDoc } from "../domain/docs";
import {
  JournalSchema,
  type JournalInput,
  type LineInput,
  assertBalanced,
  assertSingleCurrency,
} from "../domain/types";
import {
  describeLine,
  validateAllTransitions,
} from "../domain/stateMachine";
import { log, metrics } from "../util/log";

/** Return type for a successful journal post */
export interface PostJournalResult {
  ok: true;
  journalId: string;
}

/** Return type for account history */
export interface AccountHistory {
  accountId: string;
  currency: string;
  history: Array<{ transition: string; amount: string; timestamp: string }>;
}

/**
 * Randomly throw inside the transaction when CHAOS_PROB is set
 */
function chaosMaybe(): void {
  const p = Number.parseFloat(process.env.CHAOS_PROB ?? "0");
  if (Number.isFinite(p) && p > 0 && Math.random() < p) {
    throw new Error("CHAOS: simulated failure inside transaction");
  }
}

/**
 * Validate journal semantic rules before entering the transaction.
 * Throws with detailed messages when invalid.
 */
function preflightValidate(parsed: JournalInput): void {
  if (!parsed.lines?.length) {
    throw new Error("journal must include at least 2 lines");
  }
  // State-machine: every line's buckets must match the transition
  validateAllTransitions(parsed.lines);
  // Ensure single currency
  assertSingleCurrency(parsed.lines);
  // Debit == credit in integer cents
  assertBalanced(parsed.lines);
}

/**
 * Apply a single line's bucket deltas to its account with concurrency guard.
 *
 * @throws Error if insufficient funds or currency mismatch.
 */
export async function applyLineAtomic(
  db: Db,
  session: ClientSession,
  line: LineInput
): Promise<void> {
  const { accountId, amount, fromBucket, toBucket } = line;

  const amtNum = Number(amount.amount);
  if (!Number.isFinite(amtNum) || amtNum < 0) {
    throw new Error(`Invalid amount for account "${accountId}": ${amount.amount}`);
  }

  // ensure account exists
  await db.collection<AccountDoc>("accounts").updateOne(
    { _id: accountId },
    {
      $setOnInsert: {
        _id: accountId,
        currency: amount.currency,
        buckets: { available: 0, pending: 0, escrow: 0, outflow: 0 },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true, session }
  );

  // Short-circuit no-ops
  if (fromBucket && toBucket && fromBucket === toBucket) {
    await db.collection<AccountDoc>("accounts").updateOne(
      { _id: accountId },
      { $set: { updatedAt: new Date(), lastTxHint: "noop" } },
      { session }
    );
    return;
  }

  // guarded movement
  const inc: Record<string, number> = {};
  if (fromBucket) inc[`buckets.${fromBucket}`] = (inc[`buckets.${fromBucket}`] ?? 0) - amtNum;
  if (toBucket)   inc[`buckets.${toBucket}`]   = (inc[`buckets.${toBucket}`]   ?? 0) + amtNum;

  const SYSTEM_OVERDRAFT_ACCOUNTS = new Set(["ESCROW_POOL"]); // or inject/configure
  const shouldGuard = !!fromBucket && !SYSTEM_OVERDRAFT_ACCOUNTS.has(accountId);

  const predicate: Record<string, unknown> = {
    _id: accountId,
    currency: amount.currency,
  };
  if (shouldGuard) {
    predicate[`buckets.${fromBucket!}`] = { $gte: amtNum };
  }

  const updateRes = await db.collection<AccountDoc>("accounts").updateOne(
    predicate,
    { $inc: inc, $set: { updatedAt: new Date() } },
    { session }
  );

  if (updateRes.matchedCount === 0) {
    throw new Error(
      `Insufficient funds or currency mismatch for account "${accountId}" on ${describeLine(line)}`
    );
  }
}

/**
 * Persist a write-ahead ledger entry for auditability and history retrieval.
 */
async function appendLedgerEntry(
  db: Db,
  session: ClientSession,
  journalId: string,
  lineNo: number,
  line: LineInput
): Promise<void> {
  await db.collection<LedgerEntryDoc>("ledger_entries").insertOne(
    {
      journalId,
      lineNo,
      accountId: line.accountId,
      fromBucket: line.fromBucket,
      toBucket: line.toBucket,
      side: line.side,
      transition: line.transition,
      amount: line.amount.amount,
      currency: line.amount.currency,
      createdAt: new Date(),
    },
    { session }
  );
}

/**
 * Enqueue a `LedgerEvent.Posted` outbox message for asynchronous dispatch.
 */
async function enqueueOutboxPosted(
  db: Db,
  session: ClientSession,
  journalId: string
): Promise<void> {
  await db.collection<OutboxDoc>("outbox").insertOne(
    {
      journalId,
      topic: "LedgerEvent.Posted",
      payload: { journalId },
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    { session }
  );
}

/**
 * Create the journal header.
 */
async function createJournalHeader(
  db: Db,
  session: ClientSession,
  input: JournalInput
): Promise<void> {
  await db.collection<JournalDoc>("journals").insertOne(
    {
      journalId: input.journalId,
      idempotencyKey: input.idempotencyKey,
      lines: input.lines,
      status: "pending",
      createdAt: new Date(),
    },
    { session }
  );
}

/**
 * Mark a journal as `posted`.
 */
async function markJournalPosted(
  db: Db,
  session: ClientSession,
  journalId: string
): Promise<void> {
  await db.collection<JournalDoc>("journals").updateOne(
    { journalId },
    { $set: { status: "posted" } },
    { session }
  );
}

/**
 * Idempotency check that returns an existing journal.
 * If found, we short-circuit and return success.
 */
async function findExistingJournal(
  db: Db,
  session: ClientSession,
  input: JournalInput
): Promise<WithId<any> | null> {
  const existing = await db.collection<JournalDoc>("journals").findOne(
    {
      $or: [
        { idempotencyKey: input.idempotencyKey },
        { journalId: input.journalId },
      ],
    },
    { session }
  );
  return existing;
}

/**
 * Post a journal atomically
 *
 * @param db - Connected MongoDB database.
 * @param input - The journal request body.
 * @throws Error on validation failures, concurrency guards, or DB issues.
 * @returns PostJournalResult on success.
 */
export async function postJournal(db: Db, input: unknown): Promise<PostJournalResult> {
  const startedAt = Date.now();

  // Parse & validate request
  const parsed = JournalSchema.parse(input);
  preflightValidate(parsed);

  const session = db.client.startSession();

  try {
    let already: WithId<any> | null = null;

    await session.withTransaction(
      async () => {
        // if the journal already exists, return early.
        const existing = await findExistingJournal(db, session, parsed);
        if (existing) {
          already = existing;
          log({
            evt: "journal.idempotent_hit",
            journalId: existing.journalId,
            idempotencyKey: parsed.idempotencyKey,
          });
          return;
        }

        // Create journal header
        await createJournalHeader(db, session, parsed);

        // Apply all lines atomically
        let lineNo = 0;
        const affectedAccounts = new Set<string>();
        for (const line of parsed.lines) {
          lineNo++;
          await applyLineAtomic(db, session, line);
          await appendLedgerEntry(db, session, parsed.journalId, lineNo, line);
          affectedAccounts.add(line.accountId);
        }

        // Hard guard for negative balances
        await assertNoNegativeBuckets(db, session, Array.from(affectedAccounts));

        // Enqueue outbox event
        await enqueueOutboxPosted(db, session, parsed.journalId);

        // Mark journal as posted
        await markJournalPosted(db, session, parsed.journalId);

        // Simulate failure inside the transaction boundary (rolled back)
        chaosMaybe();
      },
      {
        // Transactions for ledgers should err on the side of durability.
        writeConcern: { w: "majority" },
        readConcern: { level: "majority" },
      }
    );

    metrics.incJournalOk();
    log({
      evt: "journal.posted",
      journalId: parsed.journalId,
      ms: Date.now() - startedAt,
      idemKey: parsed.idempotencyKey,
    });

    // If idempotent hit, still return success
    return { ok: true, journalId: already?.journalId ?? parsed.journalId };
  } catch (err: any) {
    metrics.incJournalFail();
    log({
      level: "error",
      evt: "journal.failed",
      journalId: parsed.journalId,
      idemKey: parsed.idempotencyKey,
      msg: err?.message ?? String(err),
      stack: err?.stack,
    });
    // Re-throw to surface proper error upstream
    throw err;
  } finally {
    await session.endSession();
  }
}

/**
 * Retrieve chronological state transitions for an account.
 *
 * @param db - Connected MongoDB database.
 * @param accountId - The account identifier
 * @param currency - Currency filter
 *
 * @returns AccountHistory including ordered transitions
 */
export async function accountHistory(
  db: Db,
  accountId: string,
  currency?: string
): Promise<AccountHistory> {
  if (!accountId || typeof accountId !== "string") {
    throw new Error("accountId is required");
  }

  const query: Record<string, unknown> = { accountId };
  if (currency) query.currency = currency;

  const items = await db
    .collection<LedgerEntryDoc>("ledger_entries")
    .find(query)
    .sort({ createdAt: 1 })
    .toArray();

  // If currency was omitted, try to infer from the first item; otherwise default to USD
  const resolvedCurrency =
    currency ?? (items[0]?.currency as string | undefined) ?? "USD";

  return {
    accountId,
    currency: resolvedCurrency,
    history: items.map((i) => ({
      transition: String(i.transition),
      amount: String(i.amount),
      timestamp: (i.createdAt as Date).toISOString(),
    })),
  };
}

async function assertNoNegativeBuckets(
  db: Db,
  session: ClientSession,
  accountIds: string[]
): Promise<void> {
  if (!accountIds.length) return;

  // Keep this aligned with the predicate guard in applyLineAtomic
  const SYSTEM_OVERDRAFT_ACCOUNTS = new Set(["ESCROW_POOL"]);

  const accountsCol = db.collection<AccountDoc>("accounts");
  const filter: Filter<AccountDoc> = { _id: { $in: accountIds } };
  const docs = await accountsCol.find(filter, { session }).toArray();

  for (const doc of docs) {
    if (SYSTEM_OVERDRAFT_ACCOUNTS.has(doc._id)) continue; // allowed to go negative

    const buckets = doc?.buckets ?? {};
    for (const k of ["available", "pending", "escrow", "outflow"] as const) {
      if ((buckets[k] ?? 0) < 0) {
        throw new Error(
          `Negative bucket "${k}" for account "${doc._id}" after journal`
        );
      }
    }
  }
}


/**
 * @file tests/journal.spec.ts
 * @description
 * Integration-style unit tests for journal posting and history using an
 * in-memory MongoDB replica set.
 */

import { setTestDb } from "../api/_core/lib/mongo";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, Db } from "mongodb";
import { postJournal, accountHistory } from "../api/_core/services/journalService";
import { validateTransition } from "../api/_core/domain/stateMachine";
import type { AccountDoc, JournalDoc, LedgerEntryDoc, OutboxDoc } from "../api/_core/domain/docs";

let replset: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;

async function seedAccounts(seed: Array<{
  _id: string;
  currency: string;
  buckets: { available: number; pending: number; escrow: number; outflow: number };
}>) {
  const docs: AccountDoc[] = seed.map((x) => ({
    ...x,
    createdAt: new Date(),
  }));
  await db.collection<AccountDoc>("accounts").insertMany(docs);
}

async function balancesOf(id: string) {
  const doc = await db.collection<AccountDoc>("accounts").findOne({ _id: id });
  return doc?.buckets ?? null;
}

beforeAll(async () => {
  // Start a single-node replica set so Mongo transactions are supported
  replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });

  client = new MongoClient(replset.getUri());
  await client.connect();
  db = client.db("ledger_test");
  setTestDb(db);

  // Create indexes similar to the app bootstrap
  await db.collection<JournalDoc>("journals").createIndexes([
    { key: { idempotencyKey: 1 }, unique: true, name: "uniq_idem" },
    { key: { journalId: 1 }, unique: true, name: "uniq_journal" },
  ]);
  await db.collection<LedgerEntryDoc>("ledger_entries").createIndexes([
    { key: { accountId: 1, createdAt: -1 }, name: "by_acct_time" },
  ]);
  await db.collection<OutboxDoc>("outbox").createIndexes([
    { key: { status: 1, nextAttemptAt: 1 }, name: "dispatch_queue" },
  ]);
  await db.collection("events_acks").createIndexes([
    { key: { journalId: 1 }, unique: true, name: "uniq_ack" },
  ]);
});

afterEach(async () => {
  // Clean all collections between tests for isolation
  const cols = await db.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
  // Disable chaos by default unless a test explicitly opts in
  process.env.CHAOS_PROB = "0";
});

afterAll(async () => {
  await client?.close();
  await replset?.stop();
  setTestDb(null);
});

describe("Journal posting", () => {
  it("posts a balanced journal with reserve + lock and enqueues outbox", async () => {
    await seedAccounts([
      { _id: "USER_1", currency: "USD", buckets: { available: 1000, pending: 0, escrow: 0, outflow: 0 } },
      { _id: "ESCROW_POOL", currency: "USD", buckets: { available: 1000, pending: 0, escrow: 0, outflow: 0 } },
    ]);

    const body = {
      journalId: "J-0001",
      idempotencyKey: "idem-0001",
      lines: [
        {
          accountId: "USER_1",
          fromBucket: "available",
          toBucket: "pending",
          side: "debit",
          amount: { currency: "USD", amount: "150" },
          transition: "reserve",
        },
        {
          accountId: "ESCROW_POOL",
          fromBucket: "available",
          toBucket: "escrow",
          side: "credit",
          amount: { currency: "USD", amount: "150" },
          transition: "lock",
        },
      ],
    };

    const res = await postJournal(db, body);
    expect(res.ok).toBe(true);
    expect(res.journalId).toBe("J-0001");

    // Ensure ledger entries were written
    const entries = await db.collection("ledger_entries").find({ journalId: "J-0001" }).sort({ lineNo: 1 }).toArray();
    expect(entries.length).toBe(2);
    expect(entries[0]).toMatchObject({ accountId: "USER_1", transition: "reserve", amount: "150", currency: "USD" });
    expect(entries[1]).toMatchObject({ accountId: "ESCROW_POOL", transition: "lock", amount: "150", currency: "USD" });

    // Ensure outbox enqueued
    const outbox = await db.collection("outbox").findOne({ journalId: "J-0001" });
    expect(outbox).toBeTruthy();
    expect(outbox?.status).toBe("pending");

    // Validate account balances moved between buckets
    const bUser = await balancesOf("USER_1");
    const bEscrow = await balancesOf("ESCROW_POOL");
    expect(bUser).toEqual({ available: 850, pending: 150, escrow: 0, outflow: 0 });
    expect(bEscrow).toEqual({ available: 850, pending: 0, escrow: 150, outflow: 0 });

    // GET history helper returns transitions
    const hist = await accountHistory(db, "USER_1", "USD");
    expect(hist.history.length).toBe(1);
    expect(hist.history[0].transition).toBe("reserve");
    expect(hist.history[0].amount).toBe("150");
  });

  it("is idempotent on duplicate idempotencyKey (no double-apply)", async () => {
    await seedAccounts([
      { _id: "A", currency: "USD", buckets: { available: 100, pending: 0, escrow: 0, outflow: 0 } },
      { _id: "B", currency: "USD", buckets: { available: 100, pending: 0, escrow: 0, outflow: 0 } },
    ]);

    const body = {
      journalId: "J-0002",
      idempotencyKey: "idem-dup-1",
      lines: [
        { accountId: "A", fromBucket: "available", toBucket: "pending", side: "debit", amount: { currency: "USD", amount: "10" }, transition: "reserve" },
        { accountId: "B", fromBucket: "available", toBucket: "escrow", side: "credit", amount: { currency: "USD", amount: "10" }, transition: "lock" },
      ],
    };

    const r1 = await postJournal(db, body);
    const r2 = await postJournal(db, body);
    expect(r1.ok && r2.ok).toBe(true);

    const entries = await db.collection("ledger_entries").find({ journalId: "J-0002" }).toArray();
    expect(entries.length).toBe(2); // not 4 — no duplicate lines

    const a = await balancesOf("A");
    const b = await balancesOf("B");
    expect(a).toEqual({ available: 90, pending: 10, escrow: 0, outflow: 0 });
    expect(b).toEqual({ available: 90, pending: 0, escrow: 10, outflow: 0 });
  });

  it("rolls back fully on chaos failure and succeeds on retry", async () => {
    await seedAccounts([
      { _id: "C", currency: "USD", buckets: { available: 20, pending: 0, escrow: 0, outflow: 0 } },
      { _id: "D", currency: "USD", buckets: { available: 20, pending: 0, escrow: 0, outflow: 0 } },
    ]);

    const body = {
      journalId: "J-CHAOS-1",
      idempotencyKey: "idem-chaos-1",
      lines: [
        { accountId: "C", fromBucket: "available", toBucket: "pending", side: "debit", amount: { currency: "USD", amount: "5" }, transition: "reserve" },
        { accountId: "D", fromBucket: "available", toBucket: "escrow", side: "credit", amount: { currency: "USD", amount: "5" }, transition: "lock" },
      ],
    };

    // Force chaos
    process.env.CHAOS_PROB = "1";
    await expect(postJournal(db, body)).rejects.toBeTruthy();

    // Ensure no partial effects persisted
    const entriesAfterFail = await db.collection("ledger_entries").find({ journalId: "J-CHAOS-1" }).toArray();
    expect(entriesAfterFail.length).toBe(0);

    const cAfterFail = await balancesOf("C");
    const dAfterFail = await balancesOf("D");
    expect(cAfterFail).toEqual({ available: 20, pending: 0, escrow: 0, outflow: 0 });
    expect(dAfterFail).toEqual({ available: 20, pending: 0, escrow: 0, outflow: 0 });

    // Retry with chaos disabled -> should succeed exactly once
    process.env.CHAOS_PROB = "0";
    const ok = await postJournal(db, body);
    expect(ok.ok).toBe(true);

    const entries = await db.collection("ledger_entries").find({ journalId: "J-CHAOS-1" }).toArray();
    expect(entries.length).toBe(2);

    const c = await balancesOf("C");
    const d = await balancesOf("D");
    expect(c).toEqual({ available: 15, pending: 5, escrow: 0, outflow: 0 });
    expect(d).toEqual({ available: 15, pending: 0, escrow: 5, outflow: 0 });
  });

  it("rejects unbalanced journals", async () => {
    await seedAccounts([
      { _id: "U1", currency: "USD", buckets: { available: 100, pending: 0, escrow: 0, outflow: 0 } },
      { _id: "U2", currency: "USD", buckets: { available: 100, pending: 0, escrow: 0, outflow: 0 } },
    ]);

    const body = {
      journalId: "J-UNBAL-1",
      idempotencyKey: "idem-unbal-1",
      lines: [
        { accountId: "U1", fromBucket: "available", toBucket: "pending", side: "debit", amount: { currency: "USD", amount: "10" }, transition: "reserve" },
        { accountId: "U2", fromBucket: "available", toBucket: "escrow", side: "credit", amount: { currency: "USD", amount: "9" }, transition: "lock" },
      ],
    } as const;

    await expect(postJournal(db, body as any)).rejects.toThrow(/balanced/i);

    // No entries or outbox should exist
    const e = await db.collection("ledger_entries").countDocuments({ journalId: "J-UNBAL-1" });
    const o = await db.collection("outbox").countDocuments({ journalId: "J-UNBAL-1" });
    expect(e).toBe(0);
    expect(o).toBe(0);
  });

  it("rejects invalid transition buckets", async () => {
    // Shape with wrong buckets for 'reserve'
    const badLine = {
      accountId: "X",
      fromBucket: "pending",
      toBucket: "escrow",
      side: "debit",
      amount: { currency: "USD", amount: "1" },
      transition: "reserve" as const,
    };

    expect(() => validateTransition(badLine as any)).toThrow(/Invalid fromBucket|expected "available"/i);
  });

  it("prevents insufficient funds (predicate guard)", async () => {
    await seedAccounts([
      { _id: "LOW", currency: "USD", buckets: { available: 3, pending: 0, escrow: 0, outflow: 0 } },
      { _id: "POOL", currency: "USD", buckets: { available: 100, pending: 0, escrow: 0, outflow: 0 } },
    ]);

    const body = {
      journalId: "J-GUARD-1",
      idempotencyKey: "idem-guard-1",
      lines: [
        { accountId: "LOW", fromBucket: "available", toBucket: "pending", side: "debit", amount: { currency: "USD", amount: "5" }, transition: "reserve" },
        { accountId: "POOL", fromBucket: "available", toBucket: "escrow", side: "credit", amount: { currency: "USD", amount: "5" }, transition: "lock" },
      ],
    };

    await expect(postJournal(db, body)).rejects.toThrow(/insufficient funds|currency mismatch/i);

    // Confirm nothing changed
    const low = await balancesOf("LOW");
    const pool = await balancesOf("POOL");
    expect(low).toEqual({ available: 3, pending: 0, escrow: 0, outflow: 0 });
    expect(pool).toEqual({ available: 100, pending: 0, escrow: 0, outflow: 0 });

    const entries = await db.collection("ledger_entries").find({ journalId: "J-GUARD-1" }).toArray();
    expect(entries.length).toBe(0);
  });
});

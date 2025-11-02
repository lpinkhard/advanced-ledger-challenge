/**
 * @file tests/transitions.spec.ts
 * @description
 * Transition flow tests
 */

import { setTestDb } from "../api/_core/lib/mongo";
import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, Db } from "mongodb";
import { postJournal } from "../api/_core/services/journalService";
import type {AccountDoc, JournalDoc, LedgerEntryDoc, OutboxDoc} from "../api/_core/domain/docs";

let replset: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;

async function seedAccounts(seed: Array<{
  _id: string;
  currency: string;
  buckets: { available: number; pending: number; escrow: number; outflow: number };
}>) {
  const docs: AccountDoc[] = seed.map((x) => ({ ...x, createdAt: new Date() }));
  await db.collection<AccountDoc>("accounts").insertMany(docs);
}

async function acct(id: string) {
  const doc = await db.collection<AccountDoc>("accounts").findOne({ _id: id });
  return doc?.buckets ?? null;
}

beforeAll(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = new MongoClient(replset.getUri());
  await client.connect();
  db = client.db("ledger_transitions");
  setTestDb(db);

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
  for (const c of await db.collections()) await c.deleteMany({});
  process.env.CHAOS_PROB = "0";
});

afterAll(async () => {
  await client?.close();
  await replset?.stop();
  setTestDb(null);
});

describe("state transitions", () => {
  it("reserve -> lock -> finalize", async () => {
    await seedAccounts([
      { _id: "USER_1", currency: "USD", buckets: { available: 200, pending: 0, escrow: 0, outflow: 0 } },
      { _id: "ESCROW_POOL", currency: "USD", buckets: { available: 0, pending: 50, escrow: 0, outflow: 0 } },
      { _id: "SYSTEM_OUTFLOW", currency: "USD", buckets: { available: 0, pending: 0, escrow: 0, outflow: 0 } },
    ]);

    // reserve
    await postJournal(db, {
      journalId: "J1",
      idempotencyKey: "idem-1",
      lines: [
        { accountId: "USER_1", fromBucket: "available", toBucket: "pending", side: "debit", amount: { currency: "USD", amount: "50" }, transition: "reserve" },
        { accountId: "ESCROW_POOL", fromBucket: "pending", toBucket: "escrow", side: "credit", amount: { currency: "USD", amount: "50" }, transition: "lock" },
      ],
    });

    // finalize
    await postJournal(db, {
      journalId: "J2",
      idempotencyKey: "idem-2",
      lines: [
        { accountId: "ESCROW_POOL", fromBucket: "escrow", toBucket: "outflow", side: "credit", amount: { currency: "USD", amount: "50" }, transition: "finalize" },
        { accountId: "SYSTEM_OUTFLOW", fromBucket: "available", toBucket: "available", side: "debit", amount: { currency: "USD", amount: "50" }, transition: "finalize" },
      ],
    });

    const u1 = await acct("USER_1");
    const pool = await acct("ESCROW_POOL");
    const sys = await acct("SYSTEM_OUTFLOW");

    // Verify ledger_entries captured the reserve -> lock -> finalize triplet
    const entries = await db
      .collection("ledger_entries")
      .find(
        { journalId: { $in: ["J1", "J2"] } },
        { projection: { journalId: 1, accountId: 1, fromBucket: 1, toBucket: 1, transition: 1, amount: 1, side: 1, createdAt: 1, lineNo: 1 } }
      )
      .sort({ journalId: 1, lineNo: 1, createdAt: 1 })
      .toArray();

    // Ignore explicit no-ops
    const nonNoops = entries.filter(
      (e) => !(e.fromBucket && e.toBucket && e.fromBucket === e.toBucket)
    );

    // Check just the transition order
    expect(nonNoops.map((e) => e.transition)).toEqual(["reserve", "lock", "finalize"]);

    // Check the triplet details are present
    expect(nonNoops).toEqual(
      expect.arrayContaining([
        // USER_1 reserve available -> pending
        expect.objectContaining({
          journalId: "J1",
          accountId: "USER_1",
          transition: "reserve",
          fromBucket: "available",
          toBucket: "pending",
          amount: "50",
        }),
        // ESCROW_POOL lock pending -> escrow
        expect.objectContaining({
          journalId: "J1",
          accountId: "ESCROW_POOL",
          transition: "lock",
          fromBucket: "pending",
          toBucket: "escrow",
          amount: "50",
        }),
        // ESCROW_POOL finalize escrow -> outflow
        expect.objectContaining({
          journalId: "J2",
          accountId: "ESCROW_POOL",
          transition: "finalize",
          fromBucket: "escrow",
          toBucket: "outflow",
          amount: "50",
        }),
      ])
    );

    expect(u1).toEqual({ available: 150, pending: 50, escrow: 0, outflow: 0 });
    expect(pool).toEqual({ available: 0, pending: 0, escrow: 0, outflow: 50 });
    expect(sys).toEqual({ available: 0, pending: 0, escrow: 0, outflow: 0 });
  });

  it("release returns funds to available (pending -> available)", async () => {
    await seedAccounts([
      { _id: "U", currency: "USD", buckets: { available: 10, pending: 5, escrow: 0, outflow: 0 } },
      { _id: "POOL", currency: "USD", buckets: { available: 100, pending: 0, escrow: 0, outflow: 0 } },
    ]);

    await postJournal(db, {
      journalId: "J3",
      idempotencyKey: "idem-3",
      lines: [
        { accountId: "U", fromBucket: "pending", toBucket: "available", side: "debit", amount: { currency: "USD", amount: "5" }, transition: "release" },
        // Balance line (credit) – can be a no-op or mirror if your design requires; here we mirror on pool available->available (no state change), but keep it simple:
        { accountId: "POOL", fromBucket: "available", toBucket: "available", side: "credit", amount: { currency: "USD", amount: "5" }, transition: "release" as any },
      ],
    });

    const u = await acct("U");
    expect(u).toEqual({ available: 15, pending: 0, escrow: 0, outflow: 0 });
  });

  it("revert moves escrow back to available", async () => {
    await seedAccounts([
      { _id: "POOL", currency: "USD", buckets: { available: 0, pending: 0, escrow: 12, outflow: 0 } },
    ]);

    await postJournal(db, {
      journalId: "J4",
      idempotencyKey: "idem-4",
      lines: [
        { accountId: "POOL", fromBucket: "escrow", toBucket: "available", side: "debit", amount: { currency: "USD", amount: "12" }, transition: "revert" },
        { accountId: "POOL", fromBucket: "available", toBucket: "available", side: "credit", amount: { currency: "USD", amount: "12" }, transition: "revert" as any },
      ],
    });

    const pool = await acct("POOL");
    expect(pool).toEqual({ available: 12, pending: 0, escrow: 0, outflow: 0 });
  });

  it("rejects cross-account currency mismatch", async () => {
    await seedAccounts([
      { _id: "A", currency: "USD", buckets: { available: 10, pending: 0, escrow: 0, outflow: 0 } },
      { _id: "B", currency: "EUR", buckets: { available: 10, pending: 0, escrow: 0, outflow: 0 } },
    ]);

    await expect(
      postJournal(db, {
        journalId: "J5",
        idempotencyKey: "idem-5",
        lines: [
          { accountId: "A", fromBucket: "available", toBucket: "pending", side: "debit", amount: { currency: "USD", amount: "5" }, transition: "reserve" },
          { accountId: "B", fromBucket: "available", toBucket: "escrow", side: "credit", amount: { currency: "USD", amount: "5" }, transition: "lock" },
        ],
      })
    ).rejects.toThrow(/currency mismatch|insufficient funds|All journal lines must use the same currency/i);
  });
});

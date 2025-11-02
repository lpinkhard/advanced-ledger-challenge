/**
 * @file tests/outbox.spec.ts
 * @description
 * Outbox processing tests
 */

import { setTestDb } from "../api/_core/lib/mongo";
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, Db } from "mongodb";
import { processOutbox } from "../api/_core/services/outboxService";
import eventsHandler from "../api/events";

let replset: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = new MongoClient(replset.getUri());
  await client.connect();
  db = client.db("ledger_outbox");
  setTestDb(db);

  await db.collection("outbox").createIndexes([
    { key: { status: 1, nextAttemptAt: 1 }, name: "dispatch_queue" },
  ]);
  await db.collection("events_acks").createIndexes([
    { key: { journalId: 1 }, unique: true, name: "uniq_ack" },
  ]);
});

afterEach(async () => {
  for (const c of await db.collections()) await c.deleteMany({});
  vi.restoreAllMocks();
});

afterAll(async () => {
  await client?.close();
  await replset?.stop();
  setTestDb(null);
});

function nowMinus(ms: number) {
  return new Date(Date.now() - ms);
}

describe("outbox processing", () => {
  it("marks events as sent on success", async () => {
    // Seed a pending event due now
    await db.collection("outbox").insertOne({
      journalId: "J-OB-1",
      topic: "LedgerEvent.Posted",
      payload: { journalId: "J-OB-1" },
      status: "pending",
      attempts: 0,
      nextAttemptAt: nowMinus(1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mock fetch -> success
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", text: async () => "" });
    // @ts-ignore
    global.fetch = fetchMock;

    const res = await processOutbox(db, {
      targetUrl: "http://local.test/events",
      maxBatch: 5,
      requestTimeoutMs: 2000,
    });

    expect(res.sent).toBe(1);
    expect(res.retried).toBe(0);

    const doc = await db.collection("outbox").findOne({ journalId: "J-OB-1" });
    expect(doc?.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("schedules retry with backoff on failure", async () => {
    await db.collection("outbox").insertOne({
      journalId: "J-OB-2",
      topic: "LedgerEvent.Posted",
      payload: { journalId: "J-OB-2" },
      status: "pending",
      attempts: 0,
      nextAttemptAt: nowMinus(1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mock fetch -> failure
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "ERR", text: async () => "boom" });
    // @ts-ignore
    global.fetch = fetchMock;

    const res = await processOutbox(db, {
      targetUrl: "http://local.test/events",
      maxBatch: 5,
      requestTimeoutMs: 2000,
      maxBackoffMs: 10_000,
    });

    expect(res.sent).toBe(0);
    expect(res.retried).toBe(1);

    const after = await db.collection("outbox").findOne({ journalId: "J-OB-2" });
    expect(after?.status).toBe("pending");
    expect(after?.attempts).toBe(1);
    expect(after?.nextAttemptAt instanceof Date).toBe(true);
  });

  it("events handler records ack and ignores duplicates (exactly-once)", async () => {
    const body = { journalId: "J-ACK-1", topic: "LedgerEvent.Posted", payload: { journalId: "J-ACK-1" } };

    // helper to call the handler directly
    const req1 = new Request("http://local/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const r1 = await eventsHandler(req1);
    expect(r1.status).toBe(200);

    const acked = await db.collection("events_acks").findOne({ journalId: "J-ACK-1" });
    expect(acked).toBeTruthy();

    // Duplicate
    const req2 = new Request("http://local/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const r2 = await eventsHandler(req2);
    expect(r2.status).toBe(200);

    const count = await db.collection("events_acks").countDocuments({ journalId: "J-ACK-1" });
    expect(count).toBe(1);
  });

  it("retries when fetch throws (network error)", async () => {
    await db.collection("outbox").insertOne({
      journalId: "J-THROW",
      topic: "LedgerEvent.Posted",
      payload: { journalId: "J-THROW" },
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(Date.now() - 1),
      createdAt: new Date(), updatedAt: new Date(),
    });

    // @ts-ignore
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const res = await processOutbox(db, { targetUrl: "http://local.test/events", maxBatch: 5, requestTimeoutMs: 2000 });
    expect(res.sent).toBe(0);
    expect(res.retried).toBe(1);

    const doc = await db.collection("outbox").findOne({ journalId: "J-THROW" });
    expect(doc?.status).toBe("pending");
    expect(doc?.attempts).toBe(1);
    expect(doc?.nextAttemptAt instanceof Date).toBe(true);
  });

  it("caps exponential backoff at maxBackoffMs", async () => {
    await db.collection("outbox").insertOne({
      journalId: "J-CAP",
      topic: "LedgerEvent.Posted",
      payload: { journalId: "J-CAP" },
      status: "pending",
      attempts: 5, // simulate prior retries
      nextAttemptAt: new Date(Date.now() - 1),
      createdAt: new Date(), updatedAt: new Date(),
    });

    // @ts-ignore
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable", text: async () => "down" });

    const maxBackoffMs = 1000;
    const before = Date.now();
    await processOutbox(db, { targetUrl: "http://local.test/events", maxBackoffMs, maxBatch: 1, requestTimeoutMs: 2000 });
    const doc = await db.collection("outbox").findOne({ journalId: "J-CAP" });
    const delay = (doc!.nextAttemptAt as Date).getTime() - before;

    expect(delay).toBeGreaterThanOrEqual(1);
    expect(delay).toBeLessThanOrEqual(maxBackoffMs + 20); // small jitter tolerance
  });

  it("skips items not yet due", async () => {
    await db.collection("outbox").insertMany([
      {
        journalId: "J-DUE",
        topic: "LedgerEvent.Posted",
        payload: { journalId: "J-DUE" },
        status: "pending", attempts: 0,
        nextAttemptAt: new Date(Date.now() - 1),
        createdAt: new Date(), updatedAt: new Date(),
      },
      {
        journalId: "J-NOT-DUE",
        topic: "LedgerEvent.Posted",
        payload: { journalId: "J-NOT-DUE" },
        status: "pending", attempts: 0,
        nextAttemptAt: new Date(Date.now() + 60_000),
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);

    // @ts-ignore
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", text: async () => "" });

    const res = await processOutbox(db, { targetUrl: "http://local.test/events", maxBatch: 10, requestTimeoutMs: 2000 });
    expect(res.sent).toBe(1);

    const due = await db.collection("outbox").findOne({ journalId: "J-DUE" });
    const notDue = await db.collection("outbox").findOne({ journalId: "J-NOT-DUE" });

    expect(due?.status).toBe("sent");
    expect(notDue?.status).toBe("pending");
  });

  it("processes at most maxBatch and in nextAttemptAt order", async () => {
    const mk = (id: string, offsetMs: number) => ({
      journalId: id, topic: "LedgerEvent.Posted",
      payload: { journalId: id }, status: "pending", attempts: 0,
      nextAttemptAt: new Date(Date.now() + offsetMs),
      createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection("outbox").insertMany([
      mk("J1", -3000), mk("J2", -2000), mk("J3", -1000),
    ]);

    const calls: string[] = [];
    // @ts-ignore
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      calls.push(body.journalId);
      return { ok: true, status: 200, statusText: "OK", text: async () => "" };
    });

    const res = await processOutbox(db, { targetUrl: "http://local.test/events", maxBatch: 2, requestTimeoutMs: 2000 });
    expect(res.sent).toBe(2);
    expect(calls).toEqual(["J1", "J2"]); // earliest due first
  });
});

/**
 * @file tests/health.spec.ts
 * @description
 * Validates the /health handler returns expected structure and values
 */

import { setTestDb } from "../api/_core/lib/mongo";
import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, Db } from "mongodb";
import healthHandler from "../api/health";

let replset: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = new MongoClient(replset.getUri());
  await client.connect();
  db = client.db("ledger_health");
  setTestDb(db);

  await db.collection("outbox").createIndexes([
    { key: { status: 1, nextAttemptAt: 1 }, name: "dispatch_queue" },
  ]);
});

afterEach(async () => {
  for (const c of await db.collections()) await c.deleteMany({});
});

afterAll(async () => {
  await client?.close();
  await replset?.stop();
  setTestDb(null);
});

describe("health endpoint", () => {
  it("returns dbConnected=true and queue stats", async () => {
    // Seed two pending, one with attempts>0
    await db.collection("outbox").insertMany([
      { journalId: "H1", status: "pending", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
      { journalId: "H2", status: "pending", attempts: 2, nextAttemptAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
    ]);

    const req = new Request("http://local/api/health", { method: "GET" });
    const res = await healthHandler(req);
    expect(res.status).toBe(200);

    // Content-Type is JSON
    expect(res.headers.get("content-type")?.toLowerCase()).toContain("application/json");

    const json = await res.json();

    // Shape/type guard
    expect(typeof json.dbConnected).toBe("boolean");
    expect(typeof json.outboxQueue).toBe("number");
    expect(typeof json.pendingRetries).toBe("number");

    expect(json.dbConnected).toBe(true);
    expect(json.outboxQueue).toBe(2);
    expect(json.pendingRetries).toBe(1);

    // metrics object exists
    expect(json.metrics).toBeTruthy();

    // Timestamp exists and is ISO-parsable
    expect(json.timestamp).toBeTruthy();
    expect(() => new Date(json.timestamp).toISOString()).not.toThrow();
  });

  it("returns zeros when queue is empty", async () => {
    const req = new Request("http://local/api/health", { method: "GET" });
    const res = await healthHandler(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.dbConnected).toBe(true);
    expect(json.outboxQueue).toBe(0);
    expect(json.pendingRetries).toBe(0);

    // Basic shape still holds
    expect(typeof json.metrics).toBe("object");
    expect(() => new Date(json.timestamp).toISOString()).not.toThrow();
  });
});

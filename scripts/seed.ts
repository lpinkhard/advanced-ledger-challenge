#!/usr/bin/env tsx
/**
 * @file scripts/seed.ts
 * @description Seeds demo accounts for manual testing
 */

import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import type { AccountDoc } from "../src/domain/docs";
dotenv.config();

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/ledger";
  const client = new MongoClient(uri);
  await client.connect();

  const db = client.db("ledger");
  const now = new Date();

  const seedAccounts = [
    { _id: "USER_1", currency: "USD", buckets: { available: 200, pending: 0, escrow: 0, outflow: 0 } },
    { _id: "ESCROW_POOL", currency: "USD", buckets: { available: 200, pending: 0, escrow: 0, outflow: 0 } },
    { _id: "SYSTEM_OUTFLOW", currency: "USD", buckets: { available: 0, pending: 0, escrow: 0, outflow: 0 } },
  ];

  for (const acct of seedAccounts) {
    await db.collection<AccountDoc>("accounts").updateOne(
      { _id: acct._id },
      {
        $setOnInsert: { _id: acct._id, createdAt: now },
        $set: { currency: acct.currency, buckets: acct.buckets, updatedAt: now },
      },
      { upsert: true }
    );
  }

  console.log(`Seeded ${seedAccounts.length} accounts:`);
  for (const a of seedAccounts) console.log(`   - ${a._id}`);

  await client.close();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

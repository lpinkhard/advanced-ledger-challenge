/**
 * @file api/health.ts
 * @description
 * Health check endpoint for the ledger system
 */

import { getDb, isMongoHealthy } from "../src/lib/mongo";
import { buildHealthReport } from "../src/util/log";
import { json, error, allowMethods, methodNotAllowed } from "./_util";

/**
 * Route handler for `GET /health`
 */
export default async function handler(req: Request): Promise<Response> {
  if (!allowMethods(req, ["GET"])) return methodNotAllowed(["GET"]);

  try {
    const dbConnected = await isMongoHealthy();
    if (!dbConnected) return error("Database connection failed", 500);

    const db = await getDb();
    const outboxQueue = await db.collection("outbox").countDocuments({ status: "pending" });
    const pendingRetries = await db
      .collection("outbox")
      .countDocuments({ status: "pending", attempts: { $gt: 0 } });

    const report = buildHealthReport({ dbConnected, outboxQueue, pendingRetries });
    return json(report, 200);
  } catch (err: any) {
    const msg = err?.message ?? "Internal Server Error";
    return error("Internal Server Error", 500, { message: msg });
  }
}

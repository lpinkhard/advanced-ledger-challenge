/**
 * @file api/events.ts
 * @description
 * Local mock consumer endpoint for ledger outbox events
 */

import { getDb } from "../src/lib/mongo";
import { json, error, allowMethods, methodNotAllowed } from "./_util";
import { log } from "../src/util/log";

export const config = { runtime: "nodejs" };

export default async function handler(req: Request): Promise<Response> {
  if (!allowMethods(req, ["POST"])) return methodNotAllowed(["POST"]);

  try {
    const db = await getDb();
    const { journalId, topic, payload } = await req.json();

    if (!journalId || typeof journalId !== "string") {
      return error("Invalid payload: journalId is required", 400);
    }

    try {
      await db.collection("events_acks").insertOne({
        journalId,
        topic,
        payload,
        ackedAt: new Date(),
      });
      log({ evt: "event.ack", journalId, topic });
    } catch (e: any) {
      // Duplicate key
      if (e?.code === 11000) {
        log({ evt: "event.duplicate_ack", journalId });
      } else {
        throw e;
      }
    }

    return json({ ok: true }, 200);
  } catch (err: any) {
    const msg = err?.message ?? "Internal Server Error";
    log({ level: "error", evt: "events.failed", msg });
    return error("Internal Server Error", 500, { message: msg });
  }
}

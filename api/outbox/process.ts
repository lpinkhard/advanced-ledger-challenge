/**
 * @file api/outbox/process.ts
 * @description
 * HTTP handler for triggering the outbox dispatcher once
 */

import { getDb } from "../../src/lib/mongo";
import { processOutbox } from "../../src/services/outboxService";
import {
  requireKey,
  json,
  error,
  allowMethods,
  methodNotAllowed,
} from "../_util";

export default async function handler(req: Request): Promise<Response> {
  if (!allowMethods(req, ["POST"])) {
    return methodNotAllowed(["POST"]);
  }

  const unauth = requireKey(req);
  if (unauth) return unauth;

  try {
    const db = await getDb();

    // Parse tuning params from query string
    const url = new URL(req.url);
    const maxBatch = parseInt(url.searchParams.get("maxBatch") || "", 10);
    const maxBackoffMs = parseInt(url.searchParams.get("maxBackoffMs") || "", 10);
    const timeoutMs = parseInt(url.searchParams.get("timeoutMs") || "", 10);
    const target = url.searchParams.get("target") || undefined;

    const res = await processOutbox(db, {
      maxBatch: Number.isFinite(maxBatch) ? maxBatch : undefined,
      maxBackoffMs: Number.isFinite(maxBackoffMs) ? maxBackoffMs : undefined,
      requestTimeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      targetUrl: target,
    });

    return json(res, 200);
  } catch (e: any) {
    // Network errors or database issues
    const msg = e?.message ?? "Internal Server Error";
    return error("Internal Server Error", 500, { message: msg });
  }
}

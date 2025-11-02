/**
 * @file src/services/outboxService.ts
 * @description
 * Reliable outbox dispatcher with exponential backoff and exactly-once semantics
 */

import type { Db, Filter, FindOneAndUpdateOptions, ObjectId, Sort } from "mongodb";
import { log, metrics } from "../util/log";
import type { OutboxDoc, OutboxStatus } from "../domain/docs";

/** Configuration values for a single processing run */
export interface OutboxProcessOptions {
  /** Max number of events to attempt in one run */
  maxBatch?: number;
  /** Maximum backoff (ms) */
  maxBackoffMs?: number;
  /** Base timeout for the HTTP call (ms) */
  requestTimeoutMs?: number;
  /** Override for target URL */
  targetUrl?: string;
}

/** Result statistics for a single processing run */
export interface OutboxProcessResult {
  attempted: number;
  sent: number;
  retried: number;
  /** Current queue depth */
  pending: number;
  /** Number of pending items that have at least one retry */
  pendingRetries: number;
}

/**
 * Resolve the HTTP target endpoint for outbox dispatch
 */
function resolveTargetUrl(override?: string): string {
  if (override) return override;

  const envTarget = process.env.OUTBOX_TARGET?.trim();
  if (envTarget && /^https?:\/\//i.test(envTarget)) {
    return envTarget;
  }
  const path = envTarget && envTarget.startsWith("/")
    ? envTarget
    : "/api/events";

  const vercelHost = process.env.VERCEL_URL?.trim();
  if (vercelHost) {
    return `https://${vercelHost}${path}`;
  }
  return `http://127.0.0.1:3000${path}`;
}

/**
 * Compute exponential backoff with jitter.
 * @param attempts - Number of attempts already made
 * @param maxBackoffMs - Upper bound for backoff
 * @returns backoff in milliseconds
 */
function computeBackoffMs(attempts: number, maxBackoffMs: number): number {
  const base = Math.min(2 ** Math.min(attempts, 10) * 100, maxBackoffMs); // start at 100ms, cap growth
  const jitter = Math.floor(Math.random() * (base * 0.2)); // up to 20% jitter
  return Math.min(base + jitter, maxBackoffMs);
}

/**
 * Atomically claim a single pending event whose `nextAttemptAt` is due
 *
 * @returns the claimed document or null if none available
 */
export async function claimOne(db: Db): Promise<OutboxDoc | null> {
  const now = new Date();

  const filter: Filter<OutboxDoc> = {
    status: "pending" as OutboxStatus,
    nextAttemptAt: { $lte: now },
  };

  const update = { $set: { status: "processing" as OutboxStatus, updatedAt: now } };
  const sort: Sort = { nextAttemptAt: 1, createdAt: 1, _id: 1 };

  const options: FindOneAndUpdateOptions & { includeResultMetadata: true } = {
    sort,
    returnDocument: "after",
    includeResultMetadata: true,
  };

  const res = await db.collection<OutboxDoc>("outbox").findOneAndUpdate(filter, update, options);
  return res.value ?? null;
}

/**
 * Dispatch an outbox event to the target HTTP endpoint
 *
 * @throws Error when network indicates failure
 */
async function dispatchEvent(
  targetUrl: string,
  doc: OutboxDoc,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ journalId: doc.journalId, topic: doc.topic, payload: doc.payload }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} ${text ? `— ${text}` : ""}`.trim());
    }
  } catch (err: any) {
    // Map AbortError to a clearer message
    if (err?.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mark a processing event as successfully sent
 */
export async function markSent(db: Db, id: ObjectId): Promise<void> {
  const now = new Date();
  const res = await db.collection<OutboxDoc>("outbox").updateOne(
    { _id: id, status: "processing" },
    {
      $set: { status: "sent", updatedAt: now },
      $inc: { attempts: 1 },
    }
  );
  if (res.matchedCount !== 1) {
    throw new Error("markSent: doc not found or not in processing state");
  }
}

/**
 * Re-schedule a failed event with exponential backoff
 */
export async function scheduleRetry(db: Db, doc: OutboxDoc, maxBackoffMs: number): Promise<void> {
  const attempts = (doc.attempts ?? 0) + 1;
  const base = 500; // ms
  const delayMs = Math.min(maxBackoffMs, base * Math.pow(2, attempts - 1));
  const next = new Date(Date.now() + delayMs);

  const res = await db.collection<OutboxDoc>("outbox").updateOne(
    { _id: doc._id },
    {
      $set: {
        status: "pending",
        nextAttemptAt: next,
        updatedAt: new Date(),
      },
      $inc: { attempts: 1 },
    }
  );
  if (res.matchedCount !== 1) throw new Error("scheduleRetry: doc not found");
}

/**
 * Count queue stats
 */
export async function countQueue(db: Db): Promise<{ pending: number; pendingRetries: number }> {
  const now = new Date();

  const pending = await db.collection<OutboxDoc>("outbox").countDocuments({
    status: "pending",
    nextAttemptAt: { $lte: now },
  });

  const pendingRetries = await db.collection<OutboxDoc>("outbox").countDocuments({
    status: "pending",
    nextAttemptAt: { $gt: now },
  });

  return { pending, pendingRetries };
}

/**
 * Process due outbox events once, up to `maxBatch` items
 *
 * @param db - Connected MongoDB database
 * @param options - Processing config
 * @returns summary statistics for observability
 */
export async function processOutbox(
  db: Db,
  options: OutboxProcessOptions = {}
): Promise<OutboxProcessResult> {
  const maxBatch = options.maxBatch ?? 50;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? Number.parseInt(process.env.OUTBOX_TIMEOUT_MS ?? "5000", 10);
  const targetUrl = resolveTargetUrl(options.targetUrl);

  let attempted = 0;
  let sent = 0;
  let retried = 0;

  for (let i = 0; i < maxBatch; i++) {
    const doc = await claimOne(db);
    if (!doc) break;

    attempted++;

    try {
      await dispatchEvent(targetUrl, doc, requestTimeoutMs);
      await markSent(db, doc._id!);
      sent++;
      metrics.incOutboxSuccess?.();
      log?.({ evt: "outbox.sent", journalId: doc.journalId, attempts: doc.attempts ?? 0 });
    } catch (err: any) {
      retried++;
      log?.({
        level: "warn",
        evt: "outbox.dispatch_failed",
        journalId: doc.journalId,
        attempts: (doc.attempts ?? 0) + 1,
        error: err?.message ?? String(err),
      });
      await scheduleRetry(db, doc, maxBackoffMs);
    }
  }

  const { pending, pendingRetries } = await countQueue(db);
  return { attempted, sent, retried, pending, pendingRetries };
}

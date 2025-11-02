/**
 * @file src/util/log.ts
 * @description
 * Lightweight structured logging and in-memory metrics counters
 */

interface LogRecord {
  /** Timestamp automatically added if not present */
  ts?: string;
  /** Log severity level (info | warn | error) */
  level?: "info" | "warn" | "error";
  /** Arbitrary key-value pairs */
  [key: string]: unknown;
}

/**
 * Emit a structured JSON log line
 *
 * @param info - Arbitrary key-value data
 */
export function log(info: LogRecord): void {
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level: info.level ?? "info",
    ...info,
  };

  // Stringify with stable JSON
  try {
    console.log(JSON.stringify(record));
  } catch (err) {
    // fallback if JSON serialization fails
    console.error(
      JSON.stringify({
        ts: record.ts,
        level: "error",
        evt: "log.serialization_failed",
        error: (err as Error)?.message,
      })
    );
  }
}

/**
 * In-memory counters for simple metrics (resets on cold start)
 */
let ledgerJournalOk = 0;
let ledgerJournalFail = 0;
let outboxSuccess = 0;
let outboxRetry = 0;

/**
 * Named metric increment functions for consistent usage
 */
export const metrics = {
  /** Increment successful journal posts */
  incJournalOk(): void {
    ledgerJournalOk++;
  },
  /** Increment failed journal posts */
  incJournalFail(): void {
    ledgerJournalFail++;
  },
  /** Increment successful outbox sends */
  incOutboxSuccess(): void {
    outboxSuccess++;
  },
  /** Increment retried outbox sends */
  incOutboxRetry(): void {
    outboxRetry++;
  },

  /**
   * Produce a snapshot of current metric counters
   *
   * @returns An object suitable for JSON serialization
   */
  snapshot(): Record<string, unknown> {
    return {
      ledger_journal_total: {
        ok: ledgerJournalOk,
        fail: ledgerJournalFail,
      },
      ledger_outbox_retries_total: {
        success: outboxSuccess,
        retry: outboxRetry,
      },
    };
  },

  /**
   * Reset all counters to zero
   */
  reset(): void {
    ledgerJournalOk = 0;
    ledgerJournalFail = 0;
    outboxSuccess = 0;
    outboxRetry = 0;
  },
};

/**
 * Build a minimal health report combining DB connectivity and metric state
 *
 * @param opts - Values for db connection and queue stats
 *
 * @returns JSON-serializable health object
 */
export function buildHealthReport(opts: {
  dbConnected: boolean;
  outboxQueue?: number;
  pendingRetries?: number;
}): Record<string, unknown> {
  return {
    dbConnected: opts.dbConnected,
    outboxQueue: opts.outboxQueue ?? 0,
    pendingRetries: opts.pendingRetries ?? 0,
    metrics: metrics.snapshot(),
    timestamp: new Date().toISOString(),
  };
}

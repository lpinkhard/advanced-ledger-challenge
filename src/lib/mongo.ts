/**
 * @file src/lib/mongo.ts
 * @description
 * Robust MongoDB connection utility
 */

import {
  MongoClient,
  MongoClientOptions,
  Db,
  Collection,
  ServerApiVersion,
} from "mongodb";

/** Global cache keys to survive across restarts */
type MongoGlobal = {
  _mongoClient?: MongoClient | null;
  _mongoDb?: Db | null;
  _mongoIndexesReady?: boolean;
};

const g = globalThis as unknown as MongoGlobal;

/** Env var names used by this module */
const ENV = {
  URI: "MONGODB_URI",
  DB_NAME: "DB_NAME",
};

/** Default values */
const DEFAULTS = {
  DB_NAME: "ledger",
  /** Max attempts to connect */
  CONNECT_RETRIES: 3,
  /** Initial backoff (ms) for transient connect errors (exponential). */
  CONNECT_BACKOFF_MS: 200,
};

/** Strongly typed configuration object constructed from environment variables. */
interface MongoConfig {
  uri: string;
  dbName: string;
}

let __testDb: Db | null = null;

export function setTestDb(db: Db | null) {
  __testDb = db;
}

/**
 * Read and validate MongoDB configuration from environment variables.
 * @throws {Error} When required environment variables are missing or invalid.
 */
function getMongoConfig(): MongoConfig {
  const uri = (process.env[ENV.URI] || "").trim();
  const dbName = (process.env[ENV.DB_NAME] || DEFAULTS.DB_NAME).trim();

  if (!uri) {
    throw new Error(
      `Missing required environment variable ${ENV.URI}. ` +
      `Set a valid MongoDB connection string.`,
    );
  }
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    throw new Error(
      `${ENV.URI} must begin with "mongodb://" or "mongodb+srv://". ` +
      `Got: ${uri.substring(0, 12)}…`,
    );
  }
  if (!dbName) {
    throw new Error(
      `Missing or empty environment variable ${ENV.DB_NAME}. ` +
      `Provide a database name.`,
    );
  }

  return { uri, dbName };
}

/**
 * Build MongoClient options.
 */
function buildClientOptions(): MongoClientOptions {
  return {
    maxPoolSize: 50,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5_000,
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
    retryWrites: true,
  };
}

/**
 * Attempt to connect the MongoClient with a few retries using exponential backoff.
 * @param cfg - Mongo config.
 * @param retries - How many additional attempts (default 3).
 * @param backoffMs - Initial backoff in milliseconds (default 200ms).
 * @throws {Error} When all attempts fail.
 */
async function connectWithRetry(
  cfg: MongoConfig,
  retries = DEFAULTS.CONNECT_RETRIES,
  backoffMs = DEFAULTS.CONNECT_BACKOFF_MS,
): Promise<MongoClient> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const client = new MongoClient(cfg.uri, buildClientOptions());
      await client.connect();

      // Lightweight liveness check; throws if not okay.
      await client.db(cfg.dbName).command({ ping: 1 });
      return client;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;

      const delay = backoffMs * 2 ** attempt;
      await new Promise((res) => setTimeout(res, delay));
    }
  }

  const msg =
    (lastErr as Error)?.message ||
    (typeof lastErr === "string" ? lastErr : "Unknown error");
  throw new Error(`Mongo connection failed after retries: ${msg}`);
}

/**
 * Ensure the collections have the needed indexes. This runs once per cold start.
 * Safe to call multiple times; guarded by a global flag.
 * @param db - Connected database instance.
 */
async function ensureIndexes(db: Db): Promise<void> {
  if (g._mongoIndexesReady) return;

  try {
    await db.collection("journals").createIndexes([
      { key: { idempotencyKey: 1 }, unique: true, name: "uniq_idem" },
      { key: { journalId: 1 }, unique: true, name: "uniq_journal" },
    ]);
  } catch (e) {
    throw new Error(
      `Failed to create indexes for "journals": ${(e as Error).message}`,
    );
  }

  try {
    await db.collection("ledger_entries").createIndexes([
      { key: { accountId: 1, createdAt: -1 }, name: "by_acct_time" },
    ]);
  } catch (e) {
    throw new Error(
      `Failed to create indexes for "ledger_entries": ${(e as Error).message}`,
    );
  }

  try {
    await db.collection("outbox").createIndexes([
      { key: { status: 1, nextAttemptAt: 1 }, name: "dispatch_queue" },
    ]);
  } catch (e) {
    throw new Error(
      `Failed to create indexes for "outbox": ${(e as Error).message}`,
    );
  }

  try {
    await db.collection("events_acks").createIndexes([
      { key: { journalId: 1 }, unique: true, name: "uniq_ack" },
    ]);
  } catch (e) {
    throw new Error(
      `Failed to create indexes for "events_acks": ${(e as Error).message}`,
    );
  }

  g._mongoIndexesReady = true;
}

/**
 * Acquire a connected `Db` instance.
 * - Validates configuration
 * - Connects with retries on transient failures
 * - Ensures required indexes exactly once per cold start
 */
export async function getDb(): Promise<Db> {
  if (__testDb) return __testDb;
  if (g._mongoDb) return g._mongoDb;

  const cfg = getMongoConfig();

  // Reuse existing client when possible.
  if (g._mongoClient) {
    try {
      await g._mongoClient.db(cfg.dbName).command({ ping: 1 });
      g._mongoDb = g._mongoClient.db(cfg.dbName);
      await ensureIndexes(g._mongoDb);
      return g._mongoDb;
    } catch {
      // Existing client appears unhealthy; drop and reconnect.
      try {
        await g._mongoClient.close();
      } catch {
        // ignore close errors
      }
      g._mongoClient = null;
      g._mongoDb = null;
    }
  }

  // Fresh connect
  const client = await connectWithRetry(cfg);
  const db = client.db(cfg.dbName);

  g._mongoClient = client;
  g._mongoDb = db;

  await ensureIndexes(db);

  return db;
}

/**
 * Get the underlying MongoClient.
 * @throws {Error} If the client is not yet initialized.
 */
export function getClient(): MongoClient {
  if (!g._mongoClient) {
    throw new Error(
      "MongoClient not initialized. Call getDb() before getClient().",
    );
  }
  return g._mongoClient;
}

/**
 * Gracefully close the global Mongo client.
 */
export async function closeMongo(): Promise<void> {
  try {
    if (g._mongoClient) {
      await g._mongoClient.close();
    }
  } finally {
    g._mongoClient = null;
    g._mongoDb = null;
    g._mongoIndexesReady = false;
  }
}

/**
 * Check connectivity by issuing a ping command.
 * @returns `true` when the DB responds OK, otherwise `false`.
 */
export async function isMongoHealthy(): Promise<boolean> {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Collection helper.
 * @param name - The MongoDB collection name.
 * @typeParam T - The document shape for the collection.
 */
export async function getCollection<T = unknown>(
  name: string,
): Promise<Collection<T>> {
  const db = await getDb();
  return db.collection<T>(name);
}

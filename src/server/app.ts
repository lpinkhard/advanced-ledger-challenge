/**
 * @file src/server/app.ts
 * @description
 * Portable Express server that uses the /api route modules
 */

import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { getDb } from "../lib/mongo";
import { processOutbox } from "../services/outboxService";
import { expressWrap } from "./expressWrap";

import journalHandler from "../../api/journal";
import historyHandler from "../../api/accounts/[id]/history";
import processHandler from "../../api/outbox/process";
import eventsHandler from "../../api/events";
import healthHandler from "../../api/health";

import dotenv from "dotenv";
dotenv.config();

// Config
const PORT = parseInt(process.env.PORT || "3000", 10);
const ENABLE_OUTBOX_CRON = /^true$/i.test(process.env.ENABLE_OUTBOX_CRON || "false");
const OUTBOX_CRON_INTERVAL_MS = parseInt(process.env.OUTBOX_CRON_INTERVAL_MS || "10000", 10);

// App & middleware
const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("combined"));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

// Routes (wrapped)

// POST /journal
app.post("/journal", expressWrap(journalHandler));

// GET /accounts/:id/history
app.get(
  "/accounts/:id/history",
  expressWrap(historyHandler, (req) => ({ params: { id: req.params.id } }))
);

// POST /outbox/process
app.post("/outbox/process", expressWrap(processHandler));

// POST /events (mock consumer)
app.post("/events", expressWrap(eventsHandler));

// GET /health
app.get("/health", expressWrap(healthHandler));

// Start server
const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Ledger API listening on http://localhost:${PORT}`);
});

// Cron to process outbox periodically
let cronTimer: NodeJS.Timeout | null = null;
(async () => {
  if (!ENABLE_OUTBOX_CRON) return;
  const db = await getDb();
  const tick = async () => {
    try {
      await processOutbox(db);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("outbox.cron.error", (e as any)?.message || e);
    } finally {
      cronTimer = setTimeout(tick, OUTBOX_CRON_INTERVAL_MS);
    }
  };
  cronTimer = setTimeout(tick, OUTBOX_CRON_INTERVAL_MS);
})();

// Graceful shutdown
function shutdown() {
  if (cronTimer) clearTimeout(cronTimer);
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

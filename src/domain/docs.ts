/**
 * @file src/domain/docs.ts
 * @description
 * Document types
 */
import { ObjectId } from "mongodb";

export type Buckets = { available: number; pending: number; escrow: number; outflow: number };

export interface AccountDoc {
  _id: string;
  currency: string;
  buckets: Buckets;
  createdAt: Date;
  updatedAt?: Date;
  lastTxHint?: string;
}

export interface LedgerEntryDoc {
  journalId: string;
  lineNo: number;
  accountId: string;
  fromBucket?: string;
  toBucket?: string;
  side: "debit" | "credit";
  transition: string;
  amount: string;
  currency: string;
  createdAt: Date;
}

export interface JournalDoc {
  journalId: string;
  idempotencyKey: string;
  lines: unknown[];
  status: "pending" | "posted";
  createdAt: Date;
}

/** Statuses for outbox items */
export type OutboxStatus = "pending" | "processing" | "sent";

export interface OutboxDoc {
  _id?: ObjectId;
  journalId: string;
  topic: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

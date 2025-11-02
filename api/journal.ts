/**
 * @file api/journal.ts
 * @description
 * HTTP handler for `POST /journal`
 */

import { getDb } from "../src/lib/mongo";
import { postJournal } from "../src/services/journalService";
import {
  requireKey,
  json,
  error,
  parseJson,
  allowMethods,
  methodNotAllowed,
} from "./_util";
import { ZodError, type ZodIssue } from "zod";

export const config = { runtime: "nodejs" };

/**
 * Route handler for `POST /api/journal`
 */
export default async function handler(req: Request): Promise<Response> {
  if (!allowMethods(req, ["POST"])) {
    return methodNotAllowed(["POST"]);
  }

  const unauth = requireKey(req);
  if (unauth) return unauth;

  const body = await parseJson(req);
  if (body == null) return error("Invalid JSON", 400);

  try {
    const db = await getDb();
    const result = await postJournal(db, body);
    return json(result, 200);
  } catch (e: any) {
    // Validation errors
    if (e instanceof ZodError) {
      return error(
        "Validation failed",
        422,
        e.issues.map((iss: ZodIssue) => ({
          path: iss.path.join("."),
          message: iss.message,
          code: iss.code,
        }))
      );
    }

    // Mongo duplicate key
    if (typeof e?.code === "number" && e.code === 11000) {
      return error("Conflict: duplicate key", 409, { key: e?.keyValue });
    }

    // Domain/service errors bubble up as 400 if they look like user faults
    const msg = (e?.message ?? "").toLowerCase();
    const isUserFault =
      msg.includes("insufficient funds") ||
      msg.includes("currency") ||
      msg.includes("journal not balanced") ||
      msg.includes("invalid") ||
      msg.includes("missing");

    if (isUserFault) {
      return error(e.message || "Bad Request", 400);
    }

    // Fallback
    return error("Internal Server Error", 500);
  }
}

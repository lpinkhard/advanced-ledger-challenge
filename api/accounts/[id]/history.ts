/**
 * @file api/accounts/[id]/history.ts
 * @description
 * HTTP handler for `GET /accounts/:id/history`.
 * Returns the full chronological ledger transition history for a given account.
 */

import { getDb } from "../../../src/lib/mongo";
import { accountHistory } from "../../../src/services/journalService";
import { json, error, allowMethods, methodNotAllowed } from "../../_util";

export const config = { runtime: "nodejs" };

/**
 * Route handler for `GET /api/accounts/:id/history`
 */
export default async function handler(
  req: Request,
  ctx: { params: { id: string } }
): Promise<Response> {
  if (!allowMethods(req, ["GET"])) return methodNotAllowed(["GET"]);

  const accountId = ctx?.params?.id;
  if (!accountId) return error("Invalid accountId", 400);

  try {
    const db = await getDb();
    const url = new URL(req.url);
    const currency = url.searchParams.get("currency") ?? undefined;

    const result = await accountHistory(db, accountId, currency);

    if (!result.history || result.history.length === 0) {
      return error("Not Found", 404);
    }

    return json(result, 200);
  } catch (err: any) {
    console.error("history.error", err);
    return error("Internal Server Error", 500);
  }
}

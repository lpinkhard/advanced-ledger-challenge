/**
 * @file api/accounts/history.ts
 * @description
 * HTTP handler for `GET /accounts/:id/history`.
 * Returns the full chronological ledger transition history for a given account.
 */

import { getDb } from "../_core/lib/mongo";
import { accountHistory } from "../_core/services/journalService";
import { json, error, allowMethods, methodNotAllowed } from "../_util";

type Ctx = { params?: { id?: string } };

/**
 * Route handler for `GET /accounts/:id/history`
 */
export default async function handler(
  req: Request,
  ctx?: Ctx
): Promise<Response> {
  if (!allowMethods(req, ["GET"])) return methodNotAllowed(["GET"]);

  const url = new URL(req.url);
  const accountId = ctx?.params?.id ?? url.searchParams.get("id") ?? undefined;
  if (!accountId) return error("Invalid accountId", 400);

  try {
    const db = await getDb();
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

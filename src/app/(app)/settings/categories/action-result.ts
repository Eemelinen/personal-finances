import { CategoryManageError } from "@/server/categorization/manage";

// The result of the category and transaction Server Actions (F-015).

export type ActionResult<T = object> =
  ({ ok: true } & T) | { ok: false; error: string };

/** A `CategoryManageError` becomes the result's message; anything else throws. */
export function userError(error: unknown): { ok: false; error: string } {
  if (error instanceof CategoryManageError) {
    return { ok: false, error: error.message };
  }
  throw error;
}

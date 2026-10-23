import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/server/db/client";

export async function GET() {
  // Always run at request time, never prerendered at build.
  await connection();

  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ status: "ok", db: "ok" });
  } catch {
    return Response.json(
      { status: "error", db: "unreachable" },
      { status: 503 },
    );
  }
}

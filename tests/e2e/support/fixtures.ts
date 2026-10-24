import { createManualAccount } from "@/server/csv/import-csv";
import type { Db } from "@/server/db/client";
import { transactions } from "@/server/db/schema";

// Rows a spec writes straight into the test database (./database.ts) for
// states no page can create yet: a pending transaction comes only from a bank
// sync, and no page starts one before F-010. They live in their own account,
// named per call, so specs that filter to their own accounts never see them
// and a repeated run never collides; the amounts match nothing in other
// specs, so transfer detection never pairs them. Specs seed them, not the
// e2e server: the `dashboard` project needs a database without accounts.

/** One booked and one pending transaction in a new manual account. */
export async function seedPendingFixture(
  db: Db,
  accountName: string,
): Promise<void> {
  const accountId = await createManualAccount(
    { name: accountName, type: "checking", format: "generic" },
    { db },
  );
  await db.insert(transactions).values([
    {
      accountId,
      dedupeHash: "e2e-fixture-booked",
      bookingDate: "2023-06-14",
      amountMinor: -1_234,
      currency: "EUR",
      counterparty: "Corner shop fixture",
      counterpartyIban: "FI2112345600000785",
      status: "booked",
    },
    {
      accountId,
      dedupeHash: "e2e-fixture-pending",
      bookingDate: "2023-06-15",
      amountMinor: -8_765,
      currency: "EUR",
      counterparty: "Card reservation fixture",
      status: "pending",
    },
  ]);
}

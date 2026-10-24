import { createManualAccount } from "@/server/csv/import-csv";
import type { Db } from "@/server/db/client";
import { transactions } from "@/server/db/schema";

// Rows the e2e server writes before the app starts, for states no page can
// create yet: a pending transaction comes only from a bank sync, and no
// page starts one before F-010. They live in their own account, so specs
// that filter to their own accounts never see them; the amounts match
// nothing in other specs, so transfer detection never pairs them.

export const PENDING_FIXTURE_ACCOUNT = "E2E fixture pending";

export async function seedE2eFixtures(db: Db): Promise<void> {
  const accountId = await createManualAccount(
    { name: PENDING_FIXTURE_ACCOUNT, type: "checking", format: "generic" },
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

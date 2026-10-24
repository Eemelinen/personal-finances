import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { verifySession } from "@/lib/auth/session";
import { getEnv } from "@/server/env";

// The fake provider's stand-in for a bank's login page (F-007): only with
// `BANK_PROVIDER=fake` (tests and e2e), otherwise a 404. It sends the user
// back to the callback the way a bank does: with the state and a code, or
// with `error=access_denied` when cancelled. Plain links: the callback is a
// Route Handler, and a bank's redirect is a full page load too.

export const metadata: Metadata = { title: "Fake bank" };

export default function FakeBankPage({
  searchParams,
}: PageProps<"/connections/fake-bank">) {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
      <FakeBank searchParams={searchParams} />
    </Suspense>
  );
}

function single(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

async function FakeBank({
  searchParams,
}: Pick<PageProps<"/connections/fake-bank">, "searchParams">) {
  await verifySession();
  if (getEnv().BANK_PROVIDER !== "fake") notFound();
  const query = await searchParams;
  const state = single(query.state);
  const approve = new URLSearchParams({ state, code: single(query.code) });
  const cancel = new URLSearchParams({
    state,
    error: "access_denied",
    error_description: "The user cancelled the authorisation",
  });

  return (
    <>
      <PageHeader
        title={`Fake bank: ${single(query.bank) || "unknown"}`}
        description="A stand-in for the bank's login page (BANK_PROVIDER=fake)."
      />
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <a href={`/connections/callback?${approve}`}>Approve access</a>
        </Button>
        <Button asChild variant="outline">
          <a href={`/connections/callback?${cancel}`}>Cancel</a>
        </Button>
      </div>
    </>
  );
}

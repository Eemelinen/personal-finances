"use client";

import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveManualHolding, type ManualHoldingResult } from "./actions";

// Add or update a crypto holding of a wallet without an API (F-021).

const subscribeNothing = () => () => {};

export function ManualHoldingForm() {
  const ids = useId();
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const [result, setResult] = useState<ManualHoldingResult | null>(null);
  const [pending, startTransition] = useTransition();
  const form = useRef<HTMLFormElement>(null);

  // Not a form action: React would clear the fields after an error too.
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setResult(null);
    startTransition(async () => {
      const saved = await saveManualHolding(data);
      setResult(saved);
      if (saved.ok) form.current?.reset();
    });
  };

  return (
    <section
      aria-labelledby={`${ids}-heading`}
      className="flex flex-col gap-4 rounded-xl border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${ids}-heading`} className="text-lg font-medium">
          Add a crypto holding
        </h2>
        <p className="text-muted-foreground text-sm">
          For wallets without an API, such as a hardware wallet. Saving sets the
          wallet&apos;s quantity of the coin from today; 0 removes it. Common
          coins are priced by their symbol; for others, give the CoinGecko id
          from the coin&apos;s page on coingecko.com.
        </p>
      </div>
      <form
        ref={form}
        onSubmit={submit}
        className="grid gap-3 sm:grid-cols-4 sm:items-end"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-wallet`}>Wallet</Label>
          <Input
            id={`${ids}-wallet`}
            name="wallet"
            placeholder="Ledger"
            required
            maxLength={80}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-symbol`}>Coin symbol</Label>
          <Input
            id={`${ids}-symbol`}
            name="symbol"
            placeholder="BTC"
            required
            maxLength={20}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-quantity`}>Quantity</Label>
          <Input
            id={`${ids}-quantity`}
            name="quantity"
            inputMode="decimal"
            placeholder="0.5"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-coingecko`}>CoinGecko id (optional)</Label>
          <Input
            id={`${ids}-coingecko`}
            name="coingeckoId"
            placeholder="bitcoin"
            maxLength={100}
          />
        </div>
        <div>
          <Button type="submit" disabled={pending || !hydrated}>
            {pending ? "Saving…" : "Save holding"}
          </Button>
        </div>
      </form>
      {result && !result.ok && (
        <p role="alert" className="text-destructive text-sm">
          {result.error}
        </p>
      )}
      {result?.ok && (
        <p role="status" className="text-sm">
          Saved {result.quantity} {result.symbol} in {result.wallet}.
          {!result.priced &&
            " It has no CoinGecko id, so it stays unpriced until you give one."}
        </p>
      )}
    </section>
  );
}

import { describe, expect, it } from "vitest";
import {
  CONSENT_MARGIN_SECONDS,
  consentValidUntil,
  DEFAULT_CONSENT_SECONDS,
  hashState,
} from "@/server/connections/authorization";

const NOW = new Date("2026-10-24T09:00:00.000Z");

describe("consentValidUntil", () => {
  it("asks for the bank's maximum, less a small margin", () => {
    const until = consentValidUntil(
      { name: "Nordea", country: "FI", maximumConsentSeconds: 15_552_000 },
      NOW,
    );

    expect(until.getTime() - NOW.getTime()).toBe(
      (15_552_000 - CONSENT_MARGIN_SECONDS) * 1000,
    );
    expect(until.toISOString()).toBe("2027-04-22T08:50:00.000Z");
  });

  it("falls back to 180 days when the provider does not say", () => {
    const until = consentValidUntil(
      { name: "S-Pankki", country: "FI", maximumConsentSeconds: null },
      NOW,
    );

    expect(DEFAULT_CONSENT_SECONDS).toBe(180 * 86_400);
    expect(until.getTime() - NOW.getTime()).toBe(
      (DEFAULT_CONSENT_SECONDS - CONSENT_MARGIN_SECONDS) * 1000,
    );
  });

  it("never ends before now", () => {
    expect(
      consentValidUntil(
        { name: "Tiny", country: "FI", maximumConsentSeconds: 60 },
        NOW,
      ),
    ).toEqual(NOW);
  });
});

describe("hashState", () => {
  it("is a stable hex SHA-256 that does not contain the state", () => {
    const hash = hashState("some-state");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashState("some-state"));
    expect(hash).not.toBe(hashState("other-state"));
  });
});

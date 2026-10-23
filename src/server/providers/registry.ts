import { getEnv, type Env } from "@/server/env";
import { createFakeProvider } from "./fake";
import { isProviderId, type FinancialProvider, type ProviderId } from "./types";

// Maps the provider id stored in `provider` columns to its implementation.
// F-006 registers Enable Banking, F-012 the CSV importer.

export class UnknownProviderError extends Error {
  override readonly name = "UnknownProviderError";

  constructor(readonly providerId: string) {
    super(`No provider registered for ${JSON.stringify(providerId)}`);
  }
}

export interface ProviderRegistry {
  /** Throws `UnknownProviderError` for an id that is not registered. */
  get(id: string): FinancialProvider;
  has(id: string): boolean;
  ids(): ProviderId[];
}

export function createProviderRegistry(
  providers: Iterable<FinancialProvider>,
): ProviderRegistry {
  const byId = new Map<ProviderId, FinancialProvider>();
  for (const provider of providers) {
    if (byId.has(provider.id)) {
      throw new Error(`Provider ${provider.id} is registered twice`);
    }
    byId.set(provider.id, provider);
  }

  return {
    get(id) {
      const provider = isProviderId(id) ? byId.get(id) : undefined;
      if (!provider) throw new UnknownProviderError(id);
      return provider;
    },
    has: (id) => isProviderId(id) && byId.has(id),
    ids: () => [...byId.keys()],
  };
}

type ProviderEnv = Pick<Env, "BANK_PROVIDER">;

/**
 * The providers of a running app or worker. The fake is registered only
 * when `BANK_PROVIDER=fake` (tests and e2e), so a real installation never
 * serves fake data, even for a stray `provider = 'fake'` row.
 */
export function defaultProviders(env: ProviderEnv): FinancialProvider[] {
  return env.BANK_PROVIDER === "fake" ? [createFakeProvider()] : [];
}

let registry: ProviderRegistry | undefined;

export function getProviderRegistry(): ProviderRegistry {
  return (registry ??= createProviderRegistry(defaultProviders(getEnv())));
}

/** The implementation behind a stored `provider` id. */
export function getProvider(id: string): FinancialProvider {
  return getProviderRegistry().get(id);
}

/** The provider new bank connections use, selected by `BANK_PROVIDER`. */
export function getBankProvider(
  env: ProviderEnv = getEnv(),
  providers: ProviderRegistry = getProviderRegistry(),
): FinancialProvider {
  return providers.get(env.BANK_PROVIDER);
}

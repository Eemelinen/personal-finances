// Coins the app knows by symbol (F-021): their CoinGecko id, so the price
// update can fetch them, and a display name. Kraken balances of other
// coins stay unpriced; a manual holding can name the CoinGecko id itself.

/** CoinGecko ids and names of common coins; others stay unpriced. */
export const KNOWN_COINS: Record<
  string,
  { coingeckoId: string; name: string }
> = {
  AAVE: { coingeckoId: "aave", name: "Aave" },
  ADA: { coingeckoId: "cardano", name: "Cardano" },
  ALGO: { coingeckoId: "algorand", name: "Algorand" },
  ATOM: { coingeckoId: "cosmos", name: "Cosmos Hub" },
  AVAX: { coingeckoId: "avalanche-2", name: "Avalanche" },
  BCH: { coingeckoId: "bitcoin-cash", name: "Bitcoin Cash" },
  BTC: { coingeckoId: "bitcoin", name: "Bitcoin" },
  DAI: { coingeckoId: "dai", name: "Dai" },
  DOGE: { coingeckoId: "dogecoin", name: "Dogecoin" },
  DOT: { coingeckoId: "polkadot", name: "Polkadot" },
  ETC: { coingeckoId: "ethereum-classic", name: "Ethereum Classic" },
  ETH: { coingeckoId: "ethereum", name: "Ethereum" },
  FIL: { coingeckoId: "filecoin", name: "Filecoin" },
  KSM: { coingeckoId: "kusama", name: "Kusama" },
  LINK: { coingeckoId: "chainlink", name: "Chainlink" },
  LTC: { coingeckoId: "litecoin", name: "Litecoin" },
  NEAR: { coingeckoId: "near", name: "NEAR Protocol" },
  POL: { coingeckoId: "polygon-ecosystem-token", name: "POL (ex-MATIC)" },
  SHIB: { coingeckoId: "shiba-inu", name: "Shiba Inu" },
  SOL: { coingeckoId: "solana", name: "Solana" },
  TRX: { coingeckoId: "tron", name: "TRON" },
  UNI: { coingeckoId: "uniswap", name: "Uniswap" },
  USDC: { coingeckoId: "usd-coin", name: "USDC" },
  USDT: { coingeckoId: "tether", name: "Tether" },
  XLM: { coingeckoId: "stellar", name: "Stellar" },
  XMR: { coingeckoId: "monero", name: "Monero" },
  XRP: { coingeckoId: "ripple", name: "XRP" },
  XTZ: { coingeckoId: "tezos", name: "Tezos" },
  ZEC: { coingeckoId: "zcash", name: "Zcash" },
};

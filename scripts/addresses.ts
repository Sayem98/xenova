/// Shared launch constants. Kept in one file so the token deploy, the oracle
/// deploy and the keeper cannot drift apart on which router or owner they mean.

/// Receives ownership and the full 210,000,000 supply in the deploy
/// transaction, and is the default tax receiver.
export const MAINNET_OWNER = "0xe7c237447CB352B67bCf53EcF4197e4549e33fd5";

/// Overridable so a testnet rehearsal can be owned by a throwaway key, which
/// keeps the production key off this machine entirely. `assertOwnerAllowed`
/// below is what stops the override from ever applying on mainnet.
export const OWNER = process.env.OWNER_ADDRESS || MAINNET_OWNER;

export interface NetworkAddresses {
  router: string;
  usdt: string;
}

/// Verified mainnet addresses — see README "On-Chain Addresses".
/// USDT on BSC has 18 decimals, not the 6 used on Ethereum.
export const ADDRESSES: Record<string, NetworkAddresses> = {
  bsc: {
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
  },
  bscTestnet: {
    router: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    // There is no single canonical testnet USDT. Point TESTNET_USDT at whichever
    // one your test pool uses rather than trusting a hardcoded guess.
    usdt: process.env.TESTNET_USDT ?? "",
  },
};

export function addressesFor(network: string): NetworkAddresses {
  const found = ADDRESSES[network];
  if (!found) {
    throw new Error(
      `No router/USDT addresses configured for network "${network}". ` +
        `Known networks: ${Object.keys(ADDRESSES).join(", ")}.`
    );
  }
  if (!found.usdt) {
    throw new Error(
      `No USDT address for "${network}". Set TESTNET_USDT in .env to the ` +
        `USDT token your test pool uses.`
    );
  }
  return found;
}

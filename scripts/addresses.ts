/// Shared launch constants. Kept in one file so the token deploy, the oracle
/// deploy and the keeper cannot drift apart on which router or owner they mean.

/// Receives ownership and the full 210,000,000 supply in the deploy
/// transaction.
export const MAINNET_OWNER = "0x7311E273393d737C82FB050e914320C7919BeAEB";

/// Overridable so a testnet rehearsal can be owned by a throwaway key, which
/// keeps the production key off this machine entirely. `assertOwnerAllowed`
/// below is what stops the override from ever applying on mainnet.
export const OWNER = process.env.OWNER_ADDRESS || MAINNET_OWNER;

/// Receives the USDT sell tax. Deliberately not the owner wallet. The
/// constructor bakes this in, so getting it wrong costs a redeploy or a
/// setTaxReceiver call after the fact.
export const MAINNET_TAX_RECEIVER =
  "0x7b72d56e4Fdcf07eFa149d7512161419732f2D58";

/// Overridable so a testnet rehearsal can pay a throwaway wallet you control.
/// `assertTaxReceiverAllowed` below stops the override applying on mainnet.
export const TAX_RECEIVER = process.env.TAX_RECEIVER || MAINNET_TAX_RECEIVER;

export interface NetworkAddresses {
  router: string;
  usdt: string;
  /// Where the owner signs the steps the scripts cannot sign for it.
  explorer: string;
}

/// Verified mainnet addresses — see README "On-Chain Addresses".
/// USDT on BSC has 18 decimals, not the 6 used on Ethereum.
export const ADDRESSES: Record<string, NetworkAddresses> = {
  bsc: {
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    explorer: "https://bscscan.com",
  },
  bscTestnet: {
    router: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    // USDT is now the other half of the trading pair, so a rehearsal needs
    // enough of it to seed a pool. Run scripts/deployMockUsdt.ts and put the
    // address it prints in TESTNET_USDT. The fallback below is a real testnet
    // USDT, kept only for the case where you already hold some.
    usdt:
      process.env.TESTNET_USDT ||
      "0x7ef95a0FEE0Dd31b22626fA2e10Ee6A223F8a684",
    explorer: "https://testnet.bscscan.com",
  },
};

/// An OWNER_ADDRESS override is a testnet convenience. On mainnet it must never
/// silently redirect ownership and 210,000,000 tokens to somewhere unintended,
/// so anything but the real owner is a hard stop.
export function assertOwnerAllowed(network: string): void {
  if (network !== "bsc") return;
  if (OWNER.toLowerCase() !== MAINNET_OWNER.toLowerCase()) {
    throw new Error(
      `Refusing to deploy to mainnet with OWNER_ADDRESS=${OWNER}. ` +
        `The mainnet owner is ${MAINNET_OWNER}. Unset OWNER_ADDRESS.`
    );
  }
}

/// A TAX_RECEIVER override is the same testnet convenience, and carries the
/// same risk: every future tax payment goes wherever this points, and the
/// constructor fixes it at deploy time. Mainnet takes the real receiver only.
export function assertTaxReceiverAllowed(network: string): void {
  if (network !== "bsc") return;
  if (TAX_RECEIVER.toLowerCase() !== MAINNET_TAX_RECEIVER.toLowerCase()) {
    throw new Error(
      `Refusing to deploy to mainnet with TAX_RECEIVER=${TAX_RECEIVER}. ` +
        `The mainnet tax receiver is ${MAINNET_TAX_RECEIVER}. Unset TAX_RECEIVER.`
    );
  }
}

/// Mocks and other test-only wiring must never reach mainnet.
export function assertTestnetOnly(network: string, what: string): void {
  if (network === "bsc") {
    throw new Error(`${what} must never be deployed to mainnet.`);
  }
}

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

/// Resolves the pair the token created for itself at deploy time. `quote` is the
/// other side of it — USDT, matching what the constructor passes to createPair.
export async function pairFor(
  ethers: any,
  router: string,
  token: string,
  quote: string
): Promise<string> {
  const routerContract = await ethers.getContractAt("IPancakeRouter02", router);
  const factory = await ethers.getContractAt(
    "IPancakeFactory",
    await routerContract.factory()
  );
  return factory.getPair(token, quote);
}

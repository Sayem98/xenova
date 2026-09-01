import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "hardhat-gas-reporter";
import * as dotenv from "dotenv";

dotenv.config();

const BSC_MAINNET_RPC =
  process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org";
const BSC_TESTNET_RPC =
  process.env.BSC_TESTNET_RPC ||
  "https://data-seed-prebsc-1-s1.binance.org:8545";

const accounts = process.env.DEPLOYER_PRIVATE_KEY
  ? [process.env.DEPLOYER_PRIVATE_KEY]
  : [];

// Forking needs ARCHIVE state. The public dataseed nodes are pruned and keep
// only ~100 blocks, so they fail with "missing trie node" — which is why this
// does not reuse BSC_MAINNET_RPC. Blast's public endpoint serves BSC archive
// state for free and with no API key, verified back 5,000,000 blocks, so
// `yarn test:fork` works with no configuration. Override for your own provider.
const BSC_ARCHIVE_RPC =
  process.env.BSC_ARCHIVE_RPC || "https://bsc-mainnet.public.blastapi.io";

// Forking is opt-in: `FORK_BSC=true npx hardhat test`. Left off by default so a
// plain `npx hardhat test` never depends on network access. Pin FORK_BLOCK to
// keep fork runs cached and deterministic.
const forking =
  process.env.FORK_BSC === "true"
    ? {
        url: BSC_ARCHIVE_RPC,
        blockNumber: process.env.FORK_BLOCK
          ? Number(process.env.FORK_BLOCK)
          : undefined,
      }
    : undefined;

const bscscanApiKey =
  process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      forking,
    },
    bscTestnet: {
      url: BSC_TESTNET_RPC,
      chainId: 97,
      accounts,
    },
    bsc: {
      url: BSC_MAINNET_RPC,
      chainId: 56,
      accounts,
    },
  },
  // A single string key means an etherscan.io key, which hardhat-verify routes
  // to the Etherscan v2 API with chainid=56. Passing an object here instead
  // selects the legacy per-explorer path — api.bscscan.com, whose v1 support
  // ended May 31st 2025 — so verification would fail with a valid key.
  etherscan: {
    apiKey: bscscanApiKey,
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
  },
};

export default config;

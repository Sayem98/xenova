# Block Bids Contracts (`BBACoin`)

An EVM-compatible smart contract ecosystem for the Blockbid platform, targeting PulseChain. This repository contains the core [`BBACoin.sol`](contracts/core/BBACoin.sol) contract — **Blockbid Auction Coin (`BBA`)** — an ERC-20 token with a built-in transaction-tax engine that funds an ecosystem yield vault.

## Ecosystem Overview

Blockbid is a two-token auction economy on PulseChain. Buy → bid → stake → earn:

| Token | Role |
| --- | --- |
| **BLOCKBIDS (`BID`)** | Native auction token, valued at $1. Spent to place bids; each bid automatically mints **BBA** to the bidder. |
| **BBA** (Blockbid Auction Coin) | Companion token, tradable on external exchanges and staked in yield farms. **This is the contract in this repo.** |
| **PLS** (PulseChain) | Staking reward. Stake BBA to earn PLS daily, sourced from the 5% AMM tax that BBA swaps to PLS and routes to the yield vault. |

**Flow:** buy BID → place bids (mints BBA) → stake BBA → earn PLS every day.

> **Supply note:** the intended max supply is **500,000,000**, but `BBACoin` does **not** encode this on-chain — `mint(...)` is `MINTER_ROLE`-gated yet uncapped, and no initial supply is preminted. The 500M ceiling must be enforced by whoever holds `MINTER_ROLE` (the BID/auction contract) or by governance, not by BBA itself. The **BID** token and the staking/farm contracts are separate components and are **not** included in this repository.

## How the Smart Contract Works

`BBACoin` is a standard ERC-20 token that automatically captures a fee on automated-market-maker (AMM) trades, converts the accumulated fees to native PLS, and forwards the proceeds to a yield vault — without exposing ordinary user transfers to reverts.

### Core Mechanics

1. **5% AMM Trade Tax:** A flat `5%` (500 bps) fee is taken on buys and sells routed through a registered AMM pair. Plain wallet-to-wallet transfers are **not** taxed.
2. **Tax Exemptions:** Addresses holding `TAX_EXEMPT_ROLE` (the contract itself, the deployer, the yield vault, and the treasury) trade tax-free. Exemptions rotate automatically when the vault or treasury is reconfigured.
3. **Automated Fee Liquidation:** Once the contract's accumulated BBA balance reaches `swapTokensAtAmount` (default `10,000 BBA`), a sell trade triggers an internal swap of those tokens to PLS via the PulseX (Uniswap V2) router. The swap is capped to one threshold at a time to limit price impact and MEV risk.
4. **Yield Routing:** Swapped PLS is delivered directly to the configured `yieldVault`.
5. **Revert-Safe Swaps:** The router swap is wrapped in `try/catch`. If the pool is illiquid or the router fails, the swap is skipped silently and the user's transfer still completes; the accrued tax carries over to the next trigger.
6. **Role-Based Supply Control:** `MINTER_ROLE` can mint new supply (e.g. for reward contracts) and `BURNER_ROLE` can perform allowance-gated burns from the treasury, enabling scheduled supply contraction.

For the full functional specification, see [docs/BBAToken-SRS.md](docs/BBAToken-SRS.md).

### Roles

| Role | Purpose |
| --- | --- |
| `DEFAULT_ADMIN_ROLE` | Configures the yield vault, treasury, AMM pairs, and swap threshold. Granted to the deployer. |
| `MINTER_ROLE` | Authorizes `mint(...)` of new supply. |
| `BURNER_ROLE` | Authorizes `burnSupply(...)`, an allowance-gated burn from the treasury. |
| `TAX_EXEMPT_ROLE` | Bypasses the transfer tax. |

## Prerequisites

Ensure you have the following installed:

* [Node.js](https://nodejs.org/) v18 or newer
* [Yarn](https://yarnpkg.com/)

## Setup & Installation

Install the project dependencies from the repository root:

```bash
yarn install
```

Copy the sample environment file and fill in your values:

```bash
cp .env.sample .env
```

## Compiling the Contracts

To compile the Solidity source and generate the TypeChain typings used for integration, run:

```bash
npx hardhat compile
```

This generates the `artifacts/` and `typechain-types/` directories.

## Testing

Run the local test suite ([test/BBACoin.ts](test/BBACoin.ts) covers the tax engine, auto-swap liquidation and its failsafe, role-gated mint/burn, and the admin setters):

```bash
npx hardhat test
```

To run the tests and generate a gas consumption report:

```bash
REPORT_GAS=true npx hardhat test
```

The suite deploys `BBACoin` against lightweight Uniswap V2 mocks in [contracts/mocks/](contracts/mocks/) (`MockFactory`, `MockRouter`, `MockPair`), so no live network or fork is required.

## Deployment

`BBACoin`'s constructor takes a single argument: the address of the PulseX (Uniswap V2) **router**. At deployment the contract creates its own BBA/WPLS pair via the router's factory and registers it as an AMM pair. After deploying, the admin should call `setYieldVault(...)` and `setTreasuryWallet(...)` before production trading begins.

[scripts/deploy.ts](scripts/deploy.ts) reads the router address from the `ROUTER_ADDRESS` environment variable, so set it for the target network before running:

```bash
export ROUTER_ADDRESS=0x...   # PulseX V2 router for the chosen network
```

Deploy to PulseChain Testnet (v4):

```bash
npx hardhat run scripts/deploy.ts --network pulsechainTestnet
```

Deploy to PulseChain Mainnet:

```bash
npx hardhat run scripts/deploy.ts --network pulsechainMainnet
```

Sepolia and Ethereum mainnet are also configured in [hardhat.config.ts](hardhat.config.ts) (`--network sepolia` / `--network mainnet`).

## Contract Verification

Once deployed, verify the contract source on the block explorer, passing the router address used as the constructor argument:

```bash
npx hardhat verify --network pulsechainTestnet <DEPLOYED_CONTRACT_ADDRESS> <ROUTER_ADDRESS>
```

Replace `<DEPLOYED_CONTRACT_ADDRESS>` with the deployed address and `<ROUTER_ADDRESS>` with the PulseX router passed at construction. Use `pulsechainMainnet` (or `sepolia` / `mainnet`) as appropriate.

## Notes

* Networks `pulsechainTestnet` (chainId 943), `pulsechainMainnet` (369), `sepolia` (11155111), and `mainnet` (1) are configured in [hardhat.config.ts](hardhat.config.ts).
* Set `DEPLOYER_PRIVATE_KEY` and `ROUTER_ADDRESS` in your environment before deploying.
* Set `PULSE_TESTNET_V4_RPC`, `PULSE_MAINNET_RPC`, `SEPOLIA_RPC`, or `MAINNET_RPC` to override the default RPC endpoints.
* Set `ETHERSCAN_API_KEY` to enable verification on Etherscan-compatible explorers.

Built with Hardhat, Ethers.js v6, and OpenZeppelin v5.

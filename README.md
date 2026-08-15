# Dynamic Tax BEP20 Token

A BEP20 token for BNB Smart Chain with a fixed buy tax and a sell tax that scales
with the token's 24-hour price drop. Collected taxes are swapped to USDT and
forwarded to a tax receiver wallet.

> **Status: planning.** The specification lives in
> [implementation_plan.md](implementation_plan.md). No contract has been written
> yet — [contracts/](contracts/) and [test/](test/) are empty. See
> [Open design questions](#open-design-questions) before starting Phase 1.

## Intended Behaviour

| Item | Value |
| --- | --- |
| Name / symbol | DemoToken (`DTK`) |
| Total supply | 100,000,000 |
| Decimals | 18 |
| Buy tax | 3% (fixed) |
| Sell tax | 3% → 60%, based on the 24h price drop |
| Tax destination | USDT, sent to the configured tax receiver |

The sell tax tiers in the plan collapse to a single formula:

```
drop <= 5%           → 3%
drop 6%..17%         → 5 * (drop - 5)     // 6% → 5%, 10% → 25%, 17% → 60%
drop > 17%           → 60% (capped)
```

## On-Chain Addresses (BSC Mainnet, verified)

| Contract | Address |
| --- | --- |
| PancakeSwap V2 Router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |
| PancakeSwap V2 Factory | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| USDT | `0x55d398326f99059fF775485246999027B3197955` |

PancakeSwap V2 Router on BSC Testnet is
`0xD99D1c33F9fC3444f8101754aBC46c52416550D1`.

> **USDT on BSC has 18 decimals**, not the 6 used on Ethereum. Tests that assume
> 6 will be wrong by a factor of 10^12.

## Setup

Requires Node.js v18+ and Yarn.

```bash
yarn install
cp .env.sample .env
```

## Compile

```bash
yarn compile
```

Generates `artifacts/` and `typechain-types/`.

## Testing

```bash
yarn test          # local only, no network access needed
yarn test:fork     # forks BSC mainnet — real router, WBNB, and USDT
```

Fork tests are the only ones that exercise the real PancakeSwap pair, and
therefore the only ones that can catch the fee-on-transfer failure described
below.

**Fork testing requires a paid archive RPC.** The default
`https://bsc-dataseed.binance.org` is a pruned full node, not an archive node, so
forking against it fails immediately:

```
missing trie node   (eth_getCode at a recent block)
```

Set `BSC_MAINNET_RPC` to an archive endpoint (Alchemy, QuickNode, dRPC paid tier)
before running `yarn test:fork`. Pin `FORK_BLOCK` to keep runs cached and
deterministic.

## Deployment

Networks `bsc` (chainId 56) and `bscTestnet` (97) are configured in
[hardhat.config.ts](hardhat.config.ts). Set `DEPLOYER_PRIVATE_KEY` first. A
deploy script will be added with the contract.

Verification uses `BSCSCAN_API_KEY`:

```bash
npx hardhat verify --network bscTestnet <ADDRESS> <CONSTRUCTOR_ARGS>
```

## Open Design Questions

Two items must be resolved before the contract is written.

**1. The tax breaks ordinary PancakeSwap sells.** Taking a fee on transfer means
the pair receives less than the router promised, so `pair.swap()` fails its
balance check and reverts with `Pancake: K`. Sellers must route through
`swapExactTokensForTokensSupportingFeeOnTransferTokens`, and set a slippage
tolerance above the current tax rate. The PancakeSwap UI caps how high that can
be set, so the top tiers may not be sellable through the normal front end. This
needs to be confirmed on testnet against the real UI before launch.

**2. The oracle is unspecified.** The plan defers between a wallet-pushed value
and a TWAP. A pushed value can be front-run in the mempool and freezes at its
last reading if the updater goes offline; a value read live from pair reserves is
flash-loan manipulable. Whichever is chosen, the contract must wrap the oracle
call in `try/catch` and clamp the result, so a failing or malicious oracle cannot
freeze transfers or return a tax above the cap.

Note also that `renounceOwnership()` makes `setOracleAddress` unreachable,
permanently locking in whatever oracle is configured at that moment.

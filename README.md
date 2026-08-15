# Dynamic Tax BEP20 Token

A BEP20 token for BNB Smart Chain with a fixed buy tax and a sell tax that scales
with the token's 24-hour price drop. Collected taxes are swapped to USDT and
forwarded to a tax receiver wallet.

> **Status: planning.** The specification lives in
> [implementation_plan.md](implementation_plan.md). No contract has been written
> yet — [contracts/](contracts/) and [test/](test/) are empty. Read the
> [known limitation](#known-limitation-the-top-tax-tiers-cannot-be-sold-through-the-pancakeswap-ui)
> before starting Phase 1 — it affects what the token can do in production.

## Intended Behavior

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

## Known Limitation: the top tax tiers cannot be sold through the PancakeSwap UI

**Read this before launch.** It is a deliberate, accepted trade-off, not a bug.

Taking a fee on transfer means the pair receives less than the router promised,
so `pair.swap()` fails its balance check and reverts with `Pancake: K`. Sellers
must route through `swapExactTokensForTokensSupportingFeeOnTransferTokens` and
set slippage at least as high as the current tax rate:

```
amountOutMin = quotedOut x (1 - slippage)     // UI quote ignores the tax
actualOut    = quotedOut x (1 - tax)
need actualOut >= amountOutMin   ->   slippage >= tax
```

**PancakeSwap's UI caps manual slippage below 50%.** Entering `60` produces
"Enter a valid slippage percentage" and the applied setting silently reverts to
its previous value. A [2021 issue on the v1 interface][pcs-450] names a 49%
block, and the limit survived the rewrite.

So these tiers cannot be executed by a seller on the standard front end:

| 24h drop | Sell tax | Slippage needed | Sellable on PancakeSwap? |
| --- | --- | --- | --- |
| 10% | 25% | 25%+ | ✅ |
| 12% | 35% | 35%+ | ✅ |
| 14% | 45% | 45%+ | ⚠️ almost no headroom |
| 15% | 50% | 50%+ | ❌ |
| 16% | 55% | 55%+ | ❌ |
| 17%+ | 60% | 60%+ | ❌ |

**What a seller in those tiers experiences:** they type 60 into slippage, the UI
rejects it and keeps their old value, they press Swap, and the transaction
reverts with `Pancake: K` and no explanation. From their side this is
indistinguishable from a honeypot.

Note also that slippage must cover the tax *plus* real price impact, so a large
sell into a thin pool needs more headroom than the table shows — and whatever a
seller sets above `tax + impact` is extractable by sandwich bots.

If the top tiers need to actually function later, the options are a custom front
end that sets `amountOutMin` directly, or lowering the ceiling. The latter needs
a redeploy, since the tier curve is a `pure` function with a hardcoded cap.

[pcs-450]: https://github.com/pancakeswap/pancake-swap-interface-v1/issues/450

## Design Decisions

Settled 2026-08-15 — see [implementation_plan.md](implementation_plan.md) §0.

*   **Price source:** on-chain TWAP comparing a 30-minute average now against a
    30-minute average from 24 hours ago. This matches the 24h change figure shown
    on DEX charts, which is what the spec calls for. Comparing against a 24-hour
    *average* would read −1% where the chart reads −20%.
*   **Oracle safety:** the token wraps every oracle call in `try/catch`, clamps
    the result, and falls back to the 3% floor if the reading is stale. A failing
    or dead oracle can never freeze transfers or exceed the cap.
*   **Admin:** a plain owner key. `setOracleAddress` and `setTaxReceiver` take
    effect immediately. Do **not** call `renounceOwnership()` — it permanently
    kills both setters and locks in whatever oracle is live at that moment.

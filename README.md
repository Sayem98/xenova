# Xenova — Dynamic Tax BEP20 Token

A BEP20 token for BNB Smart Chain with a fixed buy tax and a sell tax that scales
with the token's 24-hour price drop. Collected taxes are swapped to USDT and
forwarded to a tax receiver wallet.

> **Status: implemented and tested, not yet deployed.** The specification lives
> in [implementation_plan.md](implementation_plan.md). Read the
> [known limitation](#known-limitation-the-top-tax-tiers-cannot-be-sold-through-the-pancakeswap-ui)
> before launch — it affects what the token can do in production.

## Behavior

| Item | Value |
| --- | --- |
| Name / symbol | Xenova (`Xenova`) |
| Total supply | 210,000,000 |
| Decimals | 18 |
| Owner / initial holder | `0xe7c237447CB352B67bCf53EcF4197e4549e33fd5` |
| Buy tax | 3% (fixed) |
| Sell tax | 3% → 60%, based on the 24h price drop |
| Tax destination | USDT, sent to the configured tax receiver |

Ownership and the full supply are assigned in the deploy transaction itself, via
the `initialOwner_` constructor argument — the deploy wallet ends up holding
nothing and controlling nothing. **Liquidity must therefore be added from the
owner wallet**, which is the only address holding tokens.

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
yarn test          # 36 local tests, no network access needed
yarn test:fork     # 6 tests against a BSC mainnet fork — real router, WBNB, USDT
```

Both work with **no configuration and no API key**. `yarn test` skips the fork
suite; `yarn test:fork` runs only it.

Fork tests are the only ones that exercise a real PancakeSwap pair, and so the
only ones that can reproduce the fee-on-transfer behavior described below. They
cover what a mock router cannot:

| Test | What it proves |
| --- | --- |
| 3% on a real buy | The router's quote ignores the tax; the buyer lands 3% short |
| Tier rate on a real sell | A 10% drop withholds exactly 25% |
| **`Pancake: K`** | `swapExactTokensForETH` reverts on a fee-taking token |
| Slippage below tax | 49% slippage at the 60% tier → `INSUFFICIENT_OUTPUT_AMOUNT` |
| Same sell, high slippage | Succeeds — **the contract is not a honeypot**, only the UI blocks it |
| Real USDT payout | Tax reaches the receiver as genuine 18-decimal BSC USDT |

Forking needs **archive** state. The public dataseed nodes are pruned and keep
only ~100 blocks, failing with `missing trie node`, so forking deliberately does
not use `BSC_MAINNET_RPC`. It defaults to `https://bsc-mainnet.public.blastapi.io`,
which serves BSC archive state free and without an API key (verified back
5,000,000 blocks). Override with `BSC_ARCHIVE_RPC` to use your own provider, and
pin `FORK_BLOCK` to keep runs cached and deterministic.

## Deployment

Networks `bsc` (chainId 56) and `bscTestnet` (97) are configured in
[hardhat.config.ts](hardhat.config.ts). Set `DEPLOYER_PRIVATE_KEY` first. Router
and USDT addresses per network, plus the owner address, live in
[scripts/addresses.ts](scripts/addresses.ts).

> **Deploying to mainnet? Read
> [how_to_deploy_on_mainnet.md](how_to_deploy_on_mainnet.md) first.** It covers
> the irreversible decisions, real gas costs, and the ~25-hour oracle cold start
> that must be waited out *before* announcing the token.

Launch is four steps, in this order. Every script signed by the owner checks
`token.owner()` against the signer first and exits with a clear message rather
than a raw `OwnableUnauthorizedAccount`.

```bash
# 1. Deploy the token. Supply and ownership go straight to the owner wallet.
npx hardhat run scripts/deploy.ts --network bsc

# 2. Seed the pool. Owner-signed: it holds the supply and is the only
#    fee-excluded address, which is what keeps the add from being taxed.
TOKEN_ADDRESS=0x… npx hardhat run scripts/addLiquidity.ts --network bsc

# 3. Deploy the TWAP oracle and point the token at it. Owner-signed.
TOKEN_ADDRESS=0x… npx hardhat run scripts/deployOracle.ts --network bsc

# 4. Start the keeper and leave it running. Any funded key will do.
ORACLE_ADDRESS=0x… npx hardhat run scripts/keeper.ts --network bsc
```

`scripts/status.ts` is read-only and prints the full picture at any point —
supply, owner, current tax tier, accrued tax, oracle history, pair reserves:

```bash
TOKEN_ADDRESS=0x… npx hardhat run scripts/status.ts --network bsc
```

Step 4 is not optional. The oracle only records a price when someone calls
`update()`, and nothing on chain does that by itself. Until the ring buffer holds
50 observations (~25 hours) `get24hPriceDropBps()` returns `0` and **the sell tax
stays at its 3% floor** — the dynamic tax never activates. Budget roughly 48
recorded updates a day at 106,400 gas each: about 0.00026 BNB/day at 0.05 gwei,
0.005 BNB/day at 1 gwei.

The keeper polls every 5 minutes, not every 30. `get24hPriceDropBps()` looks back
48 observations rather than 24 hours, so the two only agree while observations
land 30 minutes apart — and at a 30-minute poll, a tick arriving seconds early is
refused and slips a full period, widening that window for good. Polling faster
costs nothing: a refused call reverts during gas estimation and never becomes a
transaction.

`scripts/deployOracle.ts` refuses to run against a pair with zero reserves, since
an oracle started on an empty pool records 25 hours of meaningless observations.

Both deploy scripts print a ready-to-paste verify line. Verification uses
`BSCSCAN_API_KEY`:

```bash
npx hardhat verify --network bsc <TOKEN> "<ROUTER>" "<USDT>" "<TAX_RECEIVER>" "<OWNER>"
```

### Testnet rehearsal

Most of what a testnet run proves is already covered by `yarn test:fork`, which
needs no BNB at all. Use testnet for what a fork cannot show: the token appearing
in wallets and on the PancakeSwap testnet UI, and how a real seller experiences
the slippage cap.

`scripts/addLiquidity.ts` defaults to a deliberately small pool — 1,000,000
Xenova against **0.05 BNB** — because BSC testnet faucets drip roughly 0.1 BNB
per request. Pool size only changes price impact, not whether the tax logic
works. On mainnet both `LP_TOKENS` and `LP_BNB` must be set explicitly; there is
no safe default for a real pool.

Testnet USDT defaults to `0x7ef95a0FEE0Dd31b22626fA2e10Ee6A223F8a684` ("Tether
USD", 18 decimals), verified to have a live WBNB pool so the
`[Xenova, WBNB, USDT]` tax route can complete. Override with `TESTNET_USDT`.

Set `OWNER_ADDRESS` to a throwaway address so the production key never has to sit
in a `.env`. Deploying to **mainnet** with `OWNER_ADDRESS` set to anything other
than the real owner is refused outright.

The TWAP oracle needs ~25 hours of history before it reports a real drop, which
makes the tax tiers untestable in one sitting. `scripts/mockOracle.ts` points the
token at a `MockPriceOracle` whose drop you set directly, so every tier can be
exercised in minutes:

```bash
TOKEN_ADDRESS=0x… DROP_BPS=1000 npx hardhat run scripts/mockOracle.ts --network bscTestnet
#   0 -> 3% floor, 1000 -> 25%, 1500 -> 50%, 1700 -> 60% cap
```

It refuses to run on mainnet — a mock oracle there is an owner-controlled tax
dial with no price feed behind it. Replace it with the real oracle via step 3
before considering a rehearsal finished, and confirm with `scripts/status.ts`
that `token.oracle()` points at the `XenovaTwapOracle`.

`swapTokensAtAmount` defaults to 105,000 Xenova (0.05% of supply), which a
test-sized trade will never reach. Lower it to watch the swap-back fire:

```bash
npx hardhat console --network bscTestnet
> const t = await ethers.getContractAt("Xenova", "0x…")
> await t.setSwapTokensAtAmount(ethers.parseEther("100"))
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
*   **Admin:** a plain owner key, `0xe7c237447CB352B67bCf53EcF4197e4549e33fd5`.
    `setOracle` and `setTaxReceiver` take effect immediately. Do **not** call
    `renounceOwnership()` — it permanently kills both setters and locks in
    whatever oracle is live at that moment.

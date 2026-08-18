# Smart Contract Implementation Plan: Dynamic Tax BEP20 Token

## 0. Settled Decisions (2026-08-15)

| Decision | Choice |
| --- | --- |
| Price source | **On-chain 24h TWAP** read from the Xenova/WBNB PancakeSwap V2 pair |
| Oracle location | Separate contract behind `IPriceOracle`, swappable |
| Admin model | **Plain owner key** (`Ownable`), `setOracle` takes effect immediately |
| Drop precision | Basis points (0–10000), not whole percent |

Ruled out: Chainlink (no feed exists for an unlaunched token), push oracle
(front-runnable in the mempool; freezes at its last value if the bot dies),
self-anchoring spot price (a seller can pump spot in the same transaction to
read a 0% drop).

**Consequence of the admin choice:** `setOracle` is a live privileged
setter with no delay. It can repoint the oracle at a contract reporting a
permanent 17% drop, pinning every sell at 60%. Holders get no exit window.
Hold the owner key on a hardware wallet, and do **not** call
`renounceOwnership()` — that permanently kills the setter and locks in
whatever oracle is live at that moment, bugs included. Honeypot scanners will
report the live admin key.

## 1. Project Overview
This project involves developing a BEP20 token smart contract with a fixed buy tax (3%) and a dynamic sell tax based on the 24-hour price drop percentage. The sell tax scales according to a specific tier list. All collected taxes are automatically swapped into USDT and sent to a specified tax receiver wallet.

## 2. Token Details
*   **Token Name:** Xenova
*   **Token Symbol:** Xenova
*   **Total Supply:** 210,000,000 (210 Million)
*   **Decimals:** 18
*   **Owner / initial holder:** `0xe7c237447CB352B67bCf53EcF4197e4549e33fd5`
*   **USDT Tax Receiver Wallet:** same as the owner, above

> Ownership and the full supply are assigned in the deploy transaction through
> the `initialOwner_` constructor argument, so the deploy key never holds either.
> The consequence: **liquidity must be added from the owner wallet**, because it
> is the only address with tokens. The owner is fee-excluded in the constructor
> so that the liquidity add — which sends tokens to the pair, and so classifies
> as a sell — is not taxed.
>
> `taxReceiver` stays an owner-settable state variable rather than a constant, so
> the USDT destination can be redirected later with `setTaxReceiver(address)`.
>
> Do not add an "EOA only" guard on the receiver. A live account can carry an
> EIP-7702 delegation, which makes `taxReceiver.code.length > 0` true and would
> revert. Plain USDT transfers to it are fine; ERC-20 `transfer` does not call
> the recipient.

## 3. Core Contract Architecture
*   **Base Standards:** OpenZeppelin `ERC20`, `Ownable`.
*   **Burnable:** Include `ERC20Burnable` or implement a standard `burn` function.
*   **DEX Integration:**
    *   Interface `IPancakeRouter02` to handle swapping taxes.
    *   Interface `IPancakeFactory` to create the initial liquidity pair.
*   **Oracle Integration:** interface below, implemented by the TWAP contract in §5.

```solidity
interface IPriceOracle {
    /// @return dropBps  24h price drop in basis points, 0..10000
    /// @return updatedAt timestamp of the last keeper update
    function get24hPriceDropBps()
        external view returns (uint256 dropBps, uint256 updatedAt);
}
```

The `updatedAt` return is required. Without it there is no way to tell a
genuine "0% drop" from "the keeper stopped six days ago."

**Verified prerequisites (BSC mainnet, checked on-chain):**

| Contract | Address |
| --- | --- |
| PancakeSwap V2 Router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |
| PancakeSwap V2 Factory | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| USDT (18 decimals) | `0x55d398326f99059fF775485246999027B3197955` |

PancakeSwap V2 pairs expose `price0CumulativeLast`, `price1CumulativeLast`, and
`getReserves()` with `blockTimestampLast` — confirmed against the live
WBNB/USDT pair `0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae`. These are the
accumulators the TWAP oracle reads.

## 4. Tax Mechanics & Logic

### Buy Tax
*   Fixed at **3%** (300 bps).

### Dynamic Sell Tax (24h Price Drop Tier)
When a user sells (transfers to a registered AMM pair), the contract queries
`IPriceOracle` and applies:

| 24h drop | Sell tax |
| --- | --- |
| 0–5% | 3% |
| 6% | 5% |
| 7%–16% | +5% per additional 1% of drop |
| 17% or greater | 60% (cap) |

The full 13-row table collapses to one formula — verified to match every row:

```solidity
function getSellTaxBps(uint256 dropBps) public pure returns (uint256) {
    if (dropBps <= 500) return 300;                 // 0-5% drop -> 3%
    uint256 rate = 500 * (dropBps - 500) / 100;     // 6% -> 5%, 10% -> 25%
    if (rate < 300) rate = 300;                     // never below the 3% floor
    return rate > 6000 ? 6000 : rate;               // 17%+ -> 60% cap
}
```

The `rate < 300` floor is load-bearing. Without it the linear term starts near
zero just above a 5% drop, so a **5.01% drop would be taxed 0.05%** — far below
the 3% floor, and a seller could aim for exactly that. With the floor, anything
under a 5.6% drop pays 3% and the rate rises smoothly from there. Verified
against all 13 rows of the original table.

Working in bps matters: with whole percent, a 5.99% drop rounds to 5 and pays
3%, while 6.00% pays 5%. The boundary is gameable.

Note this is a deliberate reading of the spec. The original table only defines
whole-percent steps and is silent on fractional drops; the formula interpolates
between them rather than rounding down to the nearest whole percent.

### Oracle read: must never freeze transfers

```solidity
uint256 constant STALE_AFTER = 2 hours;

function _currentDropBps() internal view returns (uint256) {
    if (oracleAddress == address(0)) return 0;
    try IPriceOracle(oracleAddress).get24hPriceDropBps()
        returns (uint256 d, uint256 updatedAt)
    {
        if (block.timestamp - updatedAt > STALE_AFTER) return 0;  // stale -> 3% floor
        return d > 10_000 ? 10_000 : d;                           // clamp
    } catch {
        return 0;                                                 // reverts -> sells still work
    }
}
```

A dead keeper degrades to the 3% floor, never to 60%.

### Auto-Swap to USDT Logic (`swapAndSendUSDT`)
*   The contract accumulates token taxes internally.
*   Upon reaching `swapTokensAtAmount` **during a sell**, trigger an internal swap.
*   Swap path: `[address(this), WBNB, USDT_ADDRESS]`.
*   Send the resulting USDT to the configured tax receiver.
*   A `swapping` boolean lock prevents the swap from re-entering the tax logic.

**Only swap on sells, never on buys.** On a buy the pair is inside its own
`swap()` and holds its reentrancy lock, so calling the router from there reverts
with `Pancake: LOCKED`.

### Fee-on-transfer constraint (affects the sell path)

Taking a fee on transfer means the pair receives less than the router promised,
so `pair.swap()` fails its balance check:

```
revert: Pancake: K
```

Sellers must route through `swapExactTokensForTokensSupportingFeeOnTransferTokens`
and set slippage at least as high as the current tax rate:

```
amountOutMin = quotedOut x (1 - slippage)     // the quote ignores the tax
actualOut    = quotedOut x (1 - tax)
need actualOut >= amountOutMin   ->   slippage >= tax
```

At the 60% tier that requires 60% slippage. **Confirmed: the PancakeSwap UI
rejects it.** Entering `60` produces "Enter a valid slippage percentage" and the
applied setting silently stays at its previous value; a
[2021 issue on the v1 interface](https://github.com/pancakeswap/pancake-swap-interface-v1/issues/450)
names a 49% block, and the limit survived the rewrite.

**Accepted limitation — shipping the client's table as specified.** The 50%,
55%, and 60% tiers (15%, 16%, and 17%+ drops) cannot be executed by a seller on
the standard front end. That seller types 60, the UI keeps their old slippage,
they press Swap, and the transaction reverts with `Pancake: K` and no
explanation — indistinguishable from a honeypot from their side.

This is a documentation obligation, not a code change: see the "Known
limitation" section in `README.md`, and confirm the behavior with the client
before launch rather than after the first complaint. Test 12 in §7 pins the
boundary as an executable assertion.

## 5. TWAP Oracle Contract Spec

A separate contract, e.g. `XenovaTwapOracle`, reading the Xenova/WBNB pair.

**Storage:** a 50-slot ring buffer of `(priceCumulative, timestamp)` at 30-minute
granularity — 50 × 30 min = 25h of history. The extra hour past 24 exists so that
both ends of the comparison below are always available.

**`update()`** — permissionless, callable at most once per 30 minutes. It writes
the pair's current cumulative price into the next slot. The keeper **cannot
choose the value**; it can only refuse to call, which degrades to the 3% floor
via the staleness check.

**Reading the price:**
*   Determine ordering once at construction: `dtkIsToken0 = pair.token0() == dtk`,
    then use `price0CumulativeLast` or `price1CumulativeLast` accordingly.
*   Extrapolate to the current block the way `UniswapV2OracleLibrary.currentCumulativePrices()`
    does — using `getReserves()` and `blockTimestampLast`. Without this the
    accumulator is stale between trades.
*   Accumulator overflow is expected and correct. V2 relies on wrapping; do the
    subtraction in `unchecked`.

**Computing the drop — this must match the 24h figure on a DEX chart.**

The client's requirement is the **24-hour price change**, the number shown on
DexScreener/DexTools next to the "1d" timeframe. That is `price now` compared to
`price 24h ago` — *not* the price now compared to a 24-hour average. Those are
different numbers and they diverge badly. See the worked example below.

Compare two 30-minute averages: one ending now, one ending 24 hours ago.

```
// slot[0] = newest snapshot, slot[48] ~= 24h older, slot[49] ~= 24h30m older
twapNow  = (cumNow       - cum[slot 1])  / (tNow       - t[slot 1])
twapThen = (cum[slot 48] - cum[slot 49]) / (t[slot 48] - t[slot 49])

dropBps = twapNow >= twapThen ? 0 : (twapThen - twapNow) * 10000 / twapThen
```

**The "now" window starts at slot 1, not slot 0.** Starting at the newest
snapshot gives a zero-length window whenever the read happens in the same block
as a keeper update — the average computes as 0 and the drop comes out at a full
**100%**, handing every seller in that block the maximum tax. Starting one slot
further back guarantees at least one full `PERIOD` of span, because `update()`
enforces that spacing. The window is then 30–60 minutes rather than exactly 30,
which does not weaken the manipulation resistance.

Averaging each endpoint over 30 minutes is what keeps this safe. A flash loan
lives for one transaction, so it cannot move either figure. Faking a 0% drop
requires holding the price up for 30 minutes across many blocks.

**Worked example — why the average is the wrong reference.**

Token sits at $1.25, falls to $1.00 twenty-three hours ago, flat since:

| Method | Result |
| --- | --- |
| DEX chart 24h change (what the client sees) | **−20%** |
| now vs. 24h **average** | 24h avg ≈ $1.01 → **−1%** |
| now vs. 24h **ago** (this spec) | $1.25 → $1.00 = **−20%** ✅ |

The average-based version would charge a 3% tax while the client's screen reads
−20% and expects 60%. The flat-then-crash case agrees under both methods
($1.00 for 23h then $0.80 → −20%), which is exactly why this error would survive
casual testing: it only shows up when the drop happened earlier in the window.

**Never report a negative drop.** If the price rose over 24 hours, `dropBps` is
`0` and the sell tax is the 3% floor.

**Cold start:** a new token has no history. Until all 50 slots are populated
(~25 hours), return `dropBps = 0`, so the first day runs at the 3% floor.

**Keeper cost:** 48 updates/day at roughly 30–40k gas each ≈ 1.9M gas/day
(~0.0019 BNB/day at 1 gwei). Buffer depth does not change update frequency.

## 6. Implementation Steps

### Phase 1: Setup & Interfaces
1.  Solidity `^0.8.20` (matches the pinned compiler in `hardhat.config.ts`).
2.  Import OpenZeppelin `ERC20`, `ERC20Burnable`, `Ownable`.
3.  Define `IPancakeRouter02`, `IPancakeFactory`, `IPancakePair`, `IPriceOracle`.

> OZ v5 note: `_transfer` is **not** `virtual` in v5.x — only `_update` is.
> Override `_update`. `Ownable` also requires a constructor argument:
> `Ownable(msg.sender)`.

### Phase 2: State Variables & Constructor
1.  State: `pancakeV2Router`, `usdtAddress`, `taxReceiver`, `oracleAddress`, `swapTokensAtAmount`.
2.  Mappings: `_isExcludedFromFee`, and `automatedMarketMakerPairs`.
3.  Constructor: mint total supply to deployer, init router, create the WBNB pair
    and register it, set USDT, exclude owner and contract from fees.

> Track pairs in a mapping with an admin setter, not a single `pancakeV2Pair`
> address. Otherwise anyone can create a Xenova/USDT pair or a V3 pool and sell
> there untaxed.

### Phase 3: Transfer & Tax Logic
1.  Override `_update`.
2.  Classify: buy (`from` is a registered pair), sell (`to` is a registered pair), or plain transfer.
3.  Plain wallet-to-wallet transfers are **not** taxed.
4.  Buy → 3% to the contract.
5.  Sell → if threshold met and not already swapping, `swapBack()`; then read the
    oracle via `_currentDropBps()`, apply `getSellTaxBps`, send tax to the contract.

### Phase 4: Swap Back
1.  `swapBack()` guarded by the `swapping` lock.
2.  Approve the router, swap Xenova → WBNB → USDT, forward USDT to `taxReceiver`.
3.  Wrap the router call in `try/catch` so an illiquid pool cannot brick transfers.

### Phase 5: TWAP Oracle
1.  Implement `XenovaTwapOracle` per §5.
2.  Deploy after the pair exists and has liquidity.
3.  Point the token at it via `setOracle`.
4.  Run the keeper (30-minute cadence) from launch, so history starts filling immediately.

## 7. Testing Strategy (Hardhat)

Fork tests are the only ones that exercise the real PancakeSwap pair, and
therefore the only ones that can catch the `Pancake: K` failure. **They require a
paid archive RPC** — `bsc-dataseed.binance.org` is a pruned full node and fails
with `missing trie node`. Run with `yarn test:fork`.

Use local mocks only for the pure tax-math unit tests. A mock router does not
enforce the K invariant, so `swapBack` tests against mocks pass while mainnet
reverts.

**Token tests**
1.  Deployment: supply, owner, tax receiver, exclusions.
2.  Buy tax is 3%.
3.  Wallet-to-wallet transfer is untaxed.
4.  Excluded addresses pay nothing.
5.  Sell tax tiers via a mock oracle: 2% drop → 3%, 10% → 25%, 17% → 60%, 40% → 60% (cap).
6.  Boundary: 5.01% drop → 3% (floor holds, not 0.05%), 5.99% → 4.95%, 6.00% → 5%.
7.  Oracle reverts → sell still succeeds at 3%.
8.  Oracle returns 25000 → clamped to the 60% cap, not a 250% tax.
9.  Oracle `updatedAt` older than 2h → falls back to 3%.
10. Threshold met during a **buy** → does not trigger `swapBack`.
11. `swapBack` itself is not taxed (the `swapping` lock holds).
12. Slippage boundary at the top tier — pins the accepted limitation from §4:
    *   Plain `swapExactTokensForTokens` sell **reverts** with `Pancake: K`
        regardless of `amountOutMin`.
    *   At a 60% tax, `...SupportingFeeOnTransferTokens` with an `amountOutMin`
        implying **less than** 60% slippage **reverts**.
    *   The same call at **60% or more** slippage **succeeds**.

**Oracle tests**
13. Cold start: fewer than 50 slots filled → `dropBps == 0`.
14. `update()` twice within 30 minutes → second call rejected.
15. Single-transaction price pump does not move `twapNow`.
16. Accumulator wrap-around handled correctly.
17. **24h-ago, not 24h-average.** Price flat at $1.25, steps to $1.00 at t−23h,
    flat since → reported drop is **20%**, not ~1%. This is the case that
    distinguishes the two formulas; without it the wrong one passes.
18. Flat-then-crash: $1.00 for 23h, then $0.80 → 20%. Both formulas agree here,
    so this test alone proves nothing — it exists to pair with test 17.
19. Recovery never goes negative: price rose over 24h → `dropBps == 0`.
20. Tier ceiling end to end: oracle reports a 17% drop → sell tax is exactly
    6000 bps; a 40% drop is also 6000 bps.

**Integration (fork)**
21. Add real liquidity, sell until the threshold trips, assert the tax receiver's
    USDT balance increases. Remember USDT on BSC has **18** decimals.

**Cross-check against reality (BSC testnet, manual)**
22. Once deployed with liquidity, compare the oracle's `dropBps` against the 24h
    figure DexScreener shows for the same pair. They should track within about a
    percent. This is the check that actually proves the client's requirement is
    met — the unit tests only prove the formula matches its own spec.

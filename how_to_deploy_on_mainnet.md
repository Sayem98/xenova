# How to Deploy Xenova on BSC Mainnet

A step-by-step runbook. Read the whole thing once before running anything — two
of the decisions below cannot be undone after the deploy transaction confirms.

| | |
| --- | --- |
| Token | Xenova (`Xenova`), 210,000,000, 18 decimals |
| Owner | `0xe7c237447CB352B67bCf53EcF4197e4549e33fd5` |
| Chain | BNB Smart Chain, chainId 56 |
| Router | PancakeSwap V2 `0x10ED43C718714eb63d5aA57B78B54704E256024E` |
| USDT | `0x55d398326f99059fF775485246999027B3197955` (18 decimals) |

---

## 0. Read this first: the launch has a 25-hour blind spot

The sell tax is driven by a TWAP oracle that needs **50 observations, one every
30 minutes — about 25 hours** — before it can report a real 24h price drop.
Until then `get24hPriceDropBps()` returns `0` and **every sell is taxed at the 3%
floor**, no matter how far the price falls.

This is correct, deliberate behaviour (a cold or dead oracle must never freeze
trading), but it means a naive launch runs for a full day with no dynamic tax at
all.

**Do this instead:** add liquidity, start the oracle and keeper, then wait ~25
hours *before* announcing the token or driving any volume to it. Confirm with
`scripts/status.ts` that `history` has left cold start — it reads
`50 updates recorded`, not `12 / 50 — cold start`. Only then go public.

```
deploy → verify → liquidity → oracle → keeper → [WAIT ~25h] → announce
```

## 1. What you cannot change afterwards

The constructor is final. There is no upgrade path, no proxy, no setter for any
of these:

- **name, symbol, decimals, total supply** — a typo means redeploying at a new
  address
- **the owner** — passed as `initialOwner_`, receives all 210,000,000 tokens
- **the buy tax (3%) and the entire sell tax curve** — `getSellTaxBps` is a
  `pure` function with the 60% cap hardcoded. Changing the curve is a redeploy.

**Never call `renounceOwnership()`.** It permanently destroys `setOracle` and
`setTaxReceiver`, locking in whatever oracle is live at that instant — bugs
included — with no way to ever replace it.

What *can* be changed later, by the owner: the oracle address, the tax receiver,
the swap-back threshold, AMM pair registrations, and fee exclusions.

## 2. Prerequisites

**The owner key.** `0xe7c2…3fd5` will hold the entire supply and all admin
rights. Hold it on a hardware wallet. Confirm you can sign with it *before*
deploy day — a lost key here means the supply is unrecoverable and the token is
permanently unadministrable.

> That address currently carries an EIP-7702 delegation on mainnet, so
> `code.length > 0`. This is fine and expected — the contract has no "EOA only"
> guard anywhere, deliberately. Plain ERC-20 transfers to it work normally.

**Fund the owner with BNB.** As of writing it holds **0.00000108 BNB** — not
enough for a single transaction. It needs gas for every step below *plus*
whatever BNB goes into the liquidity pool.

**Decide the liquidity.** `LP_TOKENS` and `LP_BNB` have no defaults on mainnet;
the script refuses to run without both, on purpose.

**The tax receiver** is `0xc8Ba…939A`, hardcoded in `scripts/addresses.ts`.
Nothing to decide, and nothing to set in `.env`.

**Have the keeper host ready before you start.** See §7 — the token's headline
feature does not work without it.

**A BscScan API key** for verification.

## 3. Cost

Measured on a mainnet fork at real contract sizes. BNB figures at **0.05 gwei**,
the gas price observed at the time of writing:

| Step | Gas | BNB @ 0.05 gwei | BNB @ 3 gwei |
| --- | --- | --- | --- |
| Deploy Xenova | 4,683,702 | 0.000234 | 0.0141 |
| `approve` | 46,423 | 0.000002 | 0.0001 |
| `addLiquidityETH` | 257,488 | 0.000013 | 0.0008 |
| Deploy oracle | 680,786 | 0.000034 | 0.0020 |
| `setOracle` | 47,267 | 0.000002 | 0.0001 |
| **Total one-time** | **5,715,666** | **0.00029** | **0.0171** |

Gas is cheap right now but can spike. **Fund the owner with ~0.05 BNB for
operations**, well clear of any realistic spike, plus your liquidity BNB.

Ongoing: the keeper spends 106,400 gas per update, 48 times a day —
**0.00026 BNB/day (~0.008 BNB/month)** at 0.05 gwei, ~0.015 BNB/day at 3 gwei.

## 4. Configure

```bash
cp .env.sample .env
```

Set in `.env`:

```bash
DEPLOYER_PRIVATE_KEY=<the owner key>
BSCSCAN_API_KEY=<your key>
LP_TOKENS=<decided in §2>
LP_BNB=<decided in §2>
# TAX_RECEIVER=   # leave blank; the receiver is in scripts/addresses.ts
```

**Leave `OWNER_ADDRESS` and `TAX_RECEIVER` blank.** Both exist only for testnet
rehearsals. On mainnet, setting either to anything other than the real address
(`0xe7c2…3fd5` and `0xc8Ba…939A`) makes the deploy script refuse to run — those
guards are what stop 210,000,000 tokens, and every future tax payment, going to
the wrong address.

Then confirm the build is clean before touching the network:

```bash
npx hardhat clean && yarn compile
yarn test        # 36 passing
yarn test:fork   # 6 passing, against real PancakeSwap and USDT
```

Do not deploy on a red suite.

## 5. Deploy

```bash
npx hardhat run scripts/deploy.ts --network bsc
```

The script prints the constructor arguments before sending. **Read them.** This
is the last moment anything is changeable.

It then reads the state back from the chain — rather than echoing the arguments
it just sent — and prints the token address, the pair address it created, name,
symbol, total supply, owner, and the owner's balance.

**Verify immediately** — before liquidity, so holders never see an unverified
contract:

```bash
npx hardhat verify --network bsc <TOKEN_ADDRESS> \
  "0x10ED43C718714eb63d5aA57B78B54704E256024E" \
  "0x55d398326f99059fF775485246999027B3197955" \
  "<TAX_RECEIVER>" \
  "0xe7c237447CB352B67bCf53EcF4197e4549e33fd5"
```

The script prints this line filled in for you. Check on BscScan that the decoded
constructor arguments show the correct owner.

**Checkpoint:**

```bash
TOKEN_ADDRESS=0x… npx hardhat run scripts/status.ts --network bsc
```

Confirm: `Xenova / Xenova`, `210000000`, owner is `0xe7c2…3fd5` holding the full
supply, and the deploy wallet holds nothing.

## 6. Add liquidity

Must be signed by the owner — it holds the supply and is the only fee-excluded
address. That exclusion is what stops the liquidity add being taxed as a sell.

```bash
TOKEN_ADDRESS=0x… npx hardhat run scripts/addLiquidity.ts --network bsc
```

The script checks the signer is the owner, that balances cover `LP_TOKENS` and
`LP_BNB`, and that the owner is fee-excluded, before sending anything. It prints
the resulting reserves.

> The initial price is set entirely by your ratio. 1,000,000 Xenova against
> 10 BNB means 1 BNB = 100,000 Xenova. Nothing enforces a "correct" price —
> whatever you seed is the opening price.

## 7. Oracle and keeper

Only now, with the pool funded — the script refuses to run against zero reserves,
because an oracle started on an empty pool records 25 hours of meaningless data.

```bash
TOKEN_ADDRESS=0x… npx hardhat run scripts/deployOracle.ts --network bsc
```

This deploys `XenovaTwapOracle` against the live pair and calls `setOracle`.
Owner-signed. Verify it too:

```bash
npx hardhat verify --network bsc <ORACLE_ADDRESS> "<PAIR_ADDRESS>" "<TOKEN_ADDRESS>"
```

Then start the keeper and **leave it running permanently**:

```bash
ORACLE_ADDRESS=0x… npx hardhat run scripts/keeper.ts --network bsc
```

`update()` is permissionless, so this does *not* need the owner key — use a
separate funded hot wallet and keep the owner key offline.

Run it under something that restarts on failure (systemd, pm2, a container with
a restart policy). Do not run it from a laptop.

### Why it polls every 5 minutes

The keeper wakes every 5 minutes, but the oracle only accepts an update every 30.
Five ticks in six are refused, and that is the intended design — not a
misconfiguration to correct.

`get24hPriceDropBps()` looks back **48 observations**, not 24 hours. The two only
mean the same thing while observations land 30 minutes apart. Polling at exactly
30 minutes made that fragile: a tick arriving seconds early is refused, and that
observation slips a full period late, widening the lookback window permanently.
Six such slips in a day and the contract is comparing against a price 27 hours
ago while the tax tiers still call it 24.

Polling faster costs almost nothing. A refused call reverts during gas estimation
and never becomes a transaction, so it spends an RPC call, not gas. The budgeted
48 recorded updates a day in §3 are unchanged.

The log is quiet by design: refused ticks print nothing, so **one line every
30 minutes is a healthy keeper** and a gap is worth investigating.

### If the keeper stops

Readings go stale after 2 hours and the sell tax falls back to 3%. The token
keeps trading, no funds are at risk, and nothing needs repair beyond restarting
the process — but the dynamic tax is off for the whole outage.

**This deployment runs one keeper and no alerting, by choice.** Both are
defensible; the consequence is that nothing will tell you when it dies. A
supervisor restarts a crashed process, but the common failures are not crashes —
a provider network incident, an RPC endpoint rate-limiting you, or the keeper
wallet running dry all leave the service "running" and recording nothing.

So the check is manual, and someone has to own it:

```bash
TOKEN_ADDRESS=0x… npx hardhat run scripts/status.ts --network bsc
```

The `oracle` block answers it outright — there is nothing to compare against
yesterday's run:

```
oracle
  address              0x…
  type                 XenovaTwapOracle
  history              144 updates recorded
  last update          12 min ago
  keeper               ok — records every 30 min
```

| `keeper` line | Meaning |
| --- | --- |
| `ok` | Recorded within the last 40 minutes. Nothing to do. |
| `late — missed a window` | Still using real prices, but at least one update was skipped. Check the keeper log and its BNB balance. |
| `DEAD — past the 120 min window` | The token is reading 0% drop and every sell is at the 3% floor. Restart the keeper. |

The age is measured against **block time, not your machine's clock**, so it is
the same number the token's staleness check sees on chain. During the first
~25 hours `history` reads `12 / 50 — cold start` instead, which is the other
reason a 0% drop is expected (§0).

Two ways to remove the manual step later, neither required for launch: alert when
that number stops moving, or run a **second keeper** on a different provider with
a different key. The second keeper does not double gas — whichever loses the race
is refused during gas estimation and never broadcasts — so it costs hosting and a
second funded wallet, nothing more.

## 8. Wait, then verify before announcing

Check every few hours:

```bash
TOKEN_ADDRESS=0x… npx hardhat run scripts/status.ts --network bsc
```

Go public only when it shows:

- `history` reading `50 updates recorded` — no `cold start` left in the line
- `keeper` reading `ok`, and `last update` under 40 minutes
- `oracle → type: XenovaTwapOracle` (not a mock, not `(none set)`)
- pair reserves as expected
- `sell tax now` responding to real price movement

## 9. Known limitation — brief the client before launch

**The 50%, 55% and 60% tiers cannot be executed through the PancakeSwap UI.**

Taking a fee on transfer means the pair receives less than the router promised,
so sellers must use `swapExactTokensForTokensSupportingFeeOnTransferTokens` with
slippage at least as high as the tax. PancakeSwap's UI rejects manual slippage
above ~49%.

Verified on a mainnet fork: those sells **do** succeed with sufficient slippage,
so this is not a honeypot at the contract level. But a normal user in those tiers
sets 60%, is refused, presses Swap, and gets `Pancake: K` with no explanation —
indistinguishable from a scam from their side.

**In practice, tiers above a ~14% drop are unreachable for ordinary users.** If
the top of the curve needs to actually function, that requires either a custom
front end setting `amountOutMin` directly, or lowering the cap — and lowering the
cap is a redeploy.

## 10. If something goes wrong

| Problem | Response |
| --- | --- |
| Wrong name/symbol/supply/owner | Redeploy at a new address. Nothing is fixable in place. Do not add liquidity to the bad one. |
| Deploy succeeded, liquidity not yet added | Cleanest abort point. Redeploy; the abandoned contract is inert with no market. |
| Oracle misbehaving | `setOracle(<new>)` takes effect immediately. Or `setOracle(address(0))` to fall back to a flat 3% while you fix it. |
| Tax receiver wrong | `setTaxReceiver(<correct>)`. |
| Swap-back never fires | Threshold is 105,000 Xenova (0.05% of supply) and only triggers on sells. Lower with `setSwapTokensAtAmount`. |
| Keeper died | Restart it. Sell tax was at 3% while it was down; no permanent damage. |
| Sells reverting with `Pancake: K` | Expected at high tiers — see §9. Not a bug. |

There is no pause function and no blacklist, by design. The only live levers are
the oracle address, the tax receiver, the swap threshold, fee exclusions, and AMM
pair registration.

## 11. Post-launch checklist

- [ ] Both contracts verified and readable on BscScan
- [ ] Owner key on hardware wallet, backed up, tested
- [ ] `renounceOwnership()` documented internally as **never call**
- [ ] Keeper running under a supervisor (systemd/pm2), not on a laptop
- [ ] Daily `status.ts` check scheduled and **assigned to a named person** — with
      no alerting and a single keeper, this is the only thing that detects an
      outage (§7)
- [ ] Keeper wallet funded and on a top-up schedule (~0.008 BNB/month at current gas)
- [ ] Oracle confirmed out of cold start before any announcement
- [ ] Client briefed on §9, on the keeper dependency and its manual daily check,
      and on the fact that the owner key can repoint the oracle at any time —
      honeypot scanners will flag the live admin key
- [ ] First real buy and sell executed and checked against expected tax
- [ ] USDT confirmed arriving at the tax receiver after swap-back fires

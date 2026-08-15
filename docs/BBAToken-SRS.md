# Software Requirements Specification (SRS)
## BBACoin (BBA) — Blockbid Auction Coin

| Field | Value |
| --- | --- |
| Document ID | SRS-BBA-001 |
| Component | `contracts/core/BBACoin.sol` |
| Version | 1.1 |
| Status | Baseline |
| Date | 2026-06-14 |
| Author | Blockbid Contracts Team |

---

## 1. Introduction

### 1.1 Purpose
This Software Requirements Specification (SRS) defines the functional and
non-functional requirements for **BBACoin (BBA)**, the core exchange token of the
Blockbid ecosystem. BBA is an ERC-20 asset that embeds an automated transaction
taxation pipeline. The pipeline captures a fee on automated-market-maker (AMM)
trades, dynamically swaps the accumulated fees for the native chain token (PLS),
and forwards the proceeds to an ecosystem yield vault — all without exposing
ordinary user transfers to execution bottlenecks or transaction reverts.

This document is the authoritative reference for implementation, review, audit,
and acceptance testing of the contract.

### 1.2 Scope
The scope of this SRS is limited to the on-chain `BBACoin` smart contract and its
externally observable behavior:

- ERC-20 ledger and metadata.
- Role-based access control for administrative and supply operations.
- The transfer-tax engine and its exemption rules.
- The automated fee-liquidation ("swap-for-native") mechanism.
- Administrative configuration setters with permission-hygiene guarantees.
- The allowance-gated macro supply-contraction (burn) routine.

Out of scope: the consuming ecosystem contracts (e.g. `BidToken.sol`,
`QuarterlyBurner.sol`), the PulseX/Uniswap-V2 router and factory implementations,
deployment scripts, and front-end integrations. These are referenced only where
they interact with BBA.

### 1.3 Definitions, Acronyms, and Abbreviations

| Term | Definition |
| --- | --- |
| AMM | Automated Market Maker — a DEX liquidity-pool pair (e.g. PulseX V2). |
| BPS | Basis points; 1 bps = 0.01%. 10,000 bps = 100%. |
| DEX | Decentralized exchange. |
| PLS | Native gas/value token of the PulseChain network. |
| WPLS / WETH | Wrapped native token; the router exposes it as `WETH()`. |
| Buy | A trade where tokens leave an AMM pair (`from` is an AMM pair). |
| Sell | A trade where tokens enter an AMM pair (`to` is an AMM pair). |
| Yield Vault | Destination address for swapped native PLS proceeds. |
| Treasury | Corporate reserve wallet from which supply burns are drawn. |
| OZ | OpenZeppelin contracts library. |

### 1.4 References
- OpenZeppelin Contracts v5.x: `ERC20`, `ERC20Burnable`, `AccessControl`, `ReentrancyGuard`.
- Uniswap V2 router interface: `IUniswapV2Router02` (`contracts/interfaces/`).
- Uniswap V2 factory interface: `IUniswapV2Factory` (`contracts/interfaces/`).
- ERC-20 token standard (EIP-20).
- Source under specification: [contracts/core/BBACoin.sol](../contracts/core/BBACoin.sol).

### 1.5 Overview
Section 2 gives the overall description and context. Section 3 lists the detailed
functional requirements per feature. Section 4 lists non-functional requirements.
Section 5 captures external interfaces and events. Section 6 defines acceptance
criteria. Section 7 records assumptions, constraints, and known risks.

---

## 2. Overall Description

### 2.1 Product Perspective
BBACoin is a self-contained on-chain contract that inherits verified OpenZeppelin
5.x base templates and interacts with an external Uniswap-V2-style router/factory
(PulseX). At deployment it creates its own BBA/WPLS liquidity pair and registers
it as an AMM pair. Other ecosystem contracts are granted scoped roles to mint
rewards or perform scheduled burns.

```
                 ┌────────────────────────────────────────┐
   user tx ─────▶│              BBACoin._update             │
                 │  swap-check → exemption → tax → routing  │
                 └───────────────┬────────────────────────┘
                                 │ accumulated tax ≥ threshold
                                 ▼
                 swapTokensForNative ──▶ PulseX router ──▶ Yield Vault (PLS)
```

### 2.2 Architecture & Inheritance
The contract **must** compile on Solidity `^0.8.20` and inherit the following
OpenZeppelin v5.x components:

| Concern | Base Model | Purpose |
| --- | --- | --- |
| Base token | `ERC20` | Core fungible ledger: balances, allowances, metadata. |
| Supply reduction | `ERC20Burnable` | Standard public burn hooks. |
| Access rights | `AccessControl` | Granular role assignment (replaces single-owner model). |
| Asset safety | `ReentrancyGuard` | Mutual-exclusion lock around external AMM routing. |

**Metadata parameters**

| Parameter | Value |
| --- | --- |
| Token name | `Blockbid Auction Coin` |
| Token symbol | `BBA` |
| Decimals | `18` (OZ ERC-20 default) |

### 2.3 User Classes and Characteristics

| Actor | Description |
| --- | --- |
| Regular holder | Transfers BBA; pays tax only on AMM buys/sells. |
| Deployer / Admin | Holds `DEFAULT_ADMIN_ROLE`; configures vaults, pairs, thresholds. |
| Minter contract | Holds `MINTER_ROLE`; mints reward supply (e.g. `BidToken.sol`). |
| Burner engine | Holds `BURNER_ROLE`; executes scheduled supply contraction (e.g. `QuarterlyBurner.sol`). |
| Tax-exempt account | Holds `TAX_EXEMPT_ROLE`; bypasses the transfer tax. |
| Treasury wallet | Source of burned supply; must pre-approve the contract. |
| Yield vault | Receives swapped native PLS. |

### 2.4 Assumptions and Dependencies
- A functioning Uniswap-V2-compatible router (PulseX V2) exists at the address
  passed to the constructor, exposing `factory()`, `WETH()`, and
  `swapExactTokensForETHSupportingFeeOnTransferTokens(...)`.
- The router's factory can create the BBA/WPLS pair at deployment.
- The treasury executes a standard ERC-20 `approve(BBA, amount)` before any burn.
- The yield vault is configured (`setYieldVault`) before auto-swaps are expected.

---

## 3. Specific Functional Requirements

### 3.1 Access Control & Roles

| ID | Requirement |
| --- | --- |
| FR-ROLE-1 | The contract **shall** define `MINTER_ROLE`, `BURNER_ROLE`, and `TAX_EXEMPT_ROLE` as `keccak256`-derived role identifiers, in addition to OZ `DEFAULT_ADMIN_ROLE` (`0x00`). |
| FR-ROLE-2 | `DEFAULT_ADMIN_ROLE` **shall** be granted to the deployer (`msg.sender`) at construction. Holders manage configuration variables, AMM mappings, and systemic vault bindings. |
| FR-ROLE-3 | `MINTER_ROLE` **shall** authorize uncapped `_mint` calls. It is intended for ecosystem infrastructure (e.g. `BidToken.sol`). |
| FR-ROLE-4 | `BURNER_ROLE` **shall** authorize macro supply contraction via `burnSupply`. It is intended for scheduling engines (e.g. `QuarterlyBurner.sol`). |
| FR-ROLE-5 | `TAX_EXEMPT_ROLE` **shall** cause a fully tax-free transfer when held by either party. At construction it **shall** be granted to the contract itself and the deployer. The treasury and yield vault receive it when configured. |
| FR-ROLE-6 | Role administration **shall** use OZ `AccessControl` so `DEFAULT_ADMIN_ROLE` is the admin of all roles unless explicitly changed. |

### 3.2 Configuration & State

| ID | Requirement |
| --- | --- |
| FR-CFG-1 | `TAX_RATE` **shall** be a `public constant` equal to `500` and `BPS_DENOMINATOR` a `private constant` equal to `10000`, yielding an effective tax of exactly 5% (`500 / 10000`). `BPS_DENOMINATOR` is intentionally `private`: it is a static math denominator and needs no ABI getter. |
| FR-CFG-2 | `swapTokensAtAmount` **shall** be a public state variable defaulting to `10_000 * 10**decimals()` (10,000 BBA). It is the minimum internal BBA balance required before an auto-swap triggers. |
| FR-CFG-3 | `automatedMarketMakerPairs` **shall** be a public `mapping(address => bool)`. When `true`, transfers entering or exiting that address trigger tax evaluation. |
| FR-CFG-4 | At construction the contract **shall** create the BBA/WPLS pair via the router's factory, store it as `dexPair`, and register it as an AMM pair. |
| FR-CFG-5 | The constructor **shall** revert if the router address is the zero address. |

### 3.3 Transfer Hook Pipeline — `_update(from, to, value)`
All balance movements **shall** funnel through the inherited OZ 5.x `_update`
override, executing the following ordered checklist:

| ID | Requirement |
| --- | --- |
| FR-HOOK-1 | **Swapping short-circuit:** if the `swapping` flag is `true`, immediately call `super._update(from, to, value)` and return, skipping all secondary logic (prevents recursive taxing/swapping during the auto-swap). |
| FR-HOOK-2 | **Liquidation trigger:** if the contract's BBA balance ≥ `swapTokensAtAmount`, AND the transfer is not an incoming buy (`!automatedMarketMakerPairs[from]`), AND the sender is not the contract itself, AND the yield vault is configured, then invoke the internal liquidator routine. |
| FR-HOOK-3 | **Exemption filter:** if `hasRole(TAX_EXEMPT_ROLE, from)` OR `hasRole(TAX_EXEMPT_ROLE, to)` is `true`, no tax is calculated. |
| FR-HOOK-4 | **Tax calculation:** if the transfer involves an AMM pair (`automatedMarketMakerPairs[from] \|\| automatedMarketMakerPairs[to]`) and is not exempt, compute `taxAmount = (value * TAX_RATE) / BPS_DENOMINATOR`. |
| FR-HOOK-5 | **Ledger routing:** if `taxAmount > 0`, execute `super._update(from, address(this), taxAmount)`, then transfer the remainder via `super._update(from, to, value - taxAmount)`. When no tax applies, the full `value` moves to `to`. |

### 3.4 Automated Fee Liquidator — `swapTokensForNative(tokenAmount)`

| ID | Requirement |
| --- | --- |
| FR-SWAP-1 | The function **shall** be `private` and guarded by `nonReentrant`. |
| FR-SWAP-2 | **Capacity throttling:** if `tokenAmount > swapTokensAtAmount`, the amount **shall** be capped to exactly `swapTokensAtAmount`; the excess is carried to future blocks to limit slippage and MEV sandwich risk. |
| FR-SWAP-3 | **State flag:** `swapping` **shall** be set `true` before router approval and reset to `false` at termination of the routine. |
| FR-SWAP-4 | **Path routing:** the swap path **shall** be exactly `[address(this), dexRouter.WETH()]`. |
| FR-SWAP-5 | The contract **shall** approve the router for `tokenAmount` and call `swapExactTokensForETHSupportingFeeOnTransferTokens` with `amountOutMin = 0`, the configured path, recipient = `yieldVault`, and `deadline = block.timestamp`. |
| FR-SWAP-6 | **Yield routing:** the resulting native PLS **shall** be delivered directly from the router to `yieldVault`. |
| FR-SWAP-7 | **Failsafe (revert suppression):** the router call **shall** be wrapped in a `try/catch` so that an AMM failure (illiquidity, volatility, lockups) does not break the user's transfer. On failure the swap is swallowed silently and the accumulated BBA carries over to the next trigger. `swapping` **shall** be reset to `false` on both the success and failure paths, allowing the originating transfer to complete. |
| FR-SWAP-8 | A `TaxSwapped` event **shall** be emitted (on the success path) recording the amount swapped and the recipient vault. |

### 3.5 Administrative Setters (Permission Hygiene)

| ID | Requirement |
| --- | --- |
| FR-ADMIN-1 | `setYieldVault(address)` **shall** be restricted to `DEFAULT_ADMIN_ROLE`, reject the zero address, revoke `TAX_EXEMPT_ROLE` from the previous vault (if one existed and it differs), grant it to the new vault, update `yieldVault`, and emit `YieldVaultUpdated`. |
| FR-ADMIN-2 | `setTreasuryWallet(address)` **shall** follow the identical rotation logic as FR-ADMIN-1 for the treasury wallet, emitting `TreasuryWalletUpdated`. |
| FR-ADMIN-3 | Neither setter **shall** strip the contract's own permanent `TAX_EXEMPT_ROLE`, even if the previous address equals `address(this)`. |
| FR-ADMIN-4 | `setAutomatedMarketMakerPair(address, bool)` **shall** be restricted to `DEFAULT_ADMIN_ROLE`, reject the zero pair address, update the mapping, and emit `AutomatedMarketMakerPairSet`. |
| FR-ADMIN-5 | `setSwapTokensAtAmount(uint256)` **shall** be restricted to `DEFAULT_ADMIN_ROLE`, reject a zero amount, update the threshold, and emit `SwapTokensAtAmountUpdated`. |

### 3.6 Supply Management

| ID | Requirement |
| --- | --- |
| FR-SUPPLY-1 | `mint(address to, uint256 amount)` **shall** be restricted to `MINTER_ROLE` and call OZ `_mint`. |
| FR-SUPPLY-2 | `burnSupply(uint256 amount)` **shall** be restricted to `BURNER_ROLE`, require that `treasuryWallet` is set, and burn from the treasury wallet (not the contract). |
| FR-SUPPLY-3 | **Two-key gating:** `burnSupply` **shall** invoke `_spendAllowance(treasuryWallet, address(this), amount)` before `_burn`, so the treasury must have approved the contract for `amount`. A compromised burner role cannot burn beyond the treasury-authorized allowance. |
| FR-SUPPLY-4 | The inherited `ERC20Burnable` `burn`/`burnFrom` public hooks **shall** remain available for individual holders. |

### 3.7 Native Token Receipt

| ID | Requirement |
| --- | --- |
| FR-RECV-1 | The contract **shall** expose a `receive() external payable` to accept native PLS during swap operations. |

---

## 4. Non-Functional Requirements

| ID | Requirement |
| --- | --- |
| NFR-1 (Security) | All external state-mutating routing **shall** be protected against reentrancy via `ReentrancyGuard` and the `swapping` re-entry flag. |
| NFR-2 (Safety) | Zero-address inputs to configuration setters and the constructor **shall** revert. |
| NFR-3 (Robustness) | A failed auto-swap **must not** block legitimate user transfers (see FR-SWAP-7). |
| NFR-4 (Determinism) | Tax math **shall** use integer basis-point arithmetic with denominator 10,000; rounding is truncating (floor) toward zero, an accepted minor dust loss. |
| NFR-5 (Auditability) | All configuration changes and tax swaps **shall** emit indexed events. |
| NFR-6 (Compatibility) | The token **shall** remain a fully compliant EIP-20 asset for non-AMM transfers. |
| NFR-7 (Maintainability) | Code **shall** inherit unmodified OZ v5.x bases and document each role and routine with NatSpec. |
| NFR-8 (Gas) | Ordinary (non-AMM, non-trigger) transfers **should** add minimal overhead beyond the standard ERC-20 path. |

---

## 5. External Interfaces & Events

### 5.1 Public/External Functions
| Signature | Access | Purpose |
| --- | --- | --- |
| `setYieldVault(address)` | `DEFAULT_ADMIN_ROLE` | Rotate yield vault + exemption. |
| `setTreasuryWallet(address)` | `DEFAULT_ADMIN_ROLE` | Rotate treasury + exemption. |
| `setAutomatedMarketMakerPair(address,bool)` | `DEFAULT_ADMIN_ROLE` | Manage AMM pair set. |
| `setSwapTokensAtAmount(uint256)` | `DEFAULT_ADMIN_ROLE` | Update swap threshold. |
| `mint(address,uint256)` | `MINTER_ROLE` | Create new supply. |
| `burnSupply(uint256)` | `BURNER_ROLE` | Allowance-gated treasury burn. |
| `receive()` | public payable | Accept native PLS. |

### 5.2 Events
| Event | Emitted When |
| --- | --- |
| `YieldVaultUpdated(address indexed previous, address indexed new)` | Yield vault rotated. |
| `TreasuryWalletUpdated(address indexed previous, address indexed new)` | Treasury rotated. |
| `SwapTokensAtAmountUpdated(uint256 amount)` | Swap threshold changed. |
| `AutomatedMarketMakerPairSet(address indexed pair, bool value)` | AMM pair flag changed. |
| `TaxSwapped(uint256 tokensSwapped, address indexed yieldVault)` | Auto-swap executed. |

### 5.3 External Dependencies
- `IUniswapV2Router02`: `factory()`, `WETH()`, `swapExactTokensForETHSupportingFeeOnTransferTokens(...)`.
- `IUniswapV2Factory`: `createPair(address,address)`.

---

## 6. Acceptance Criteria

| ID | Criterion |
| --- | --- |
| AC-1 | A buy/sell through a registered AMM pair by a non-exempt account deducts exactly 5% to the contract and delivers 95% to the recipient. |
| AC-2 | A transfer where either party holds `TAX_EXEMPT_ROLE` incurs zero tax. |
| AC-3 | A non-AMM wallet-to-wallet transfer between non-exempt accounts incurs zero tax (tax applies only to AMM trades). |
| AC-4 | When the contract balance ≥ `swapTokensAtAmount` and the trigger conditions hold, an auto-swap fires, caps at `swapTokensAtAmount`, and delivers PLS to the yield vault, emitting `TaxSwapped`. |
| AC-5 | The `swapping` flag prevents the swap's internal transfers from being taxed or recursively triggering another swap. |
| AC-6 | Rotating the yield vault or treasury revokes `TAX_EXEMPT_ROLE` from the prior address (unless it is the contract) and grants it to the new address. |
| AC-7 | `burnSupply` reverts unless the treasury has approved the contract for at least `amount`, and on success burns from the treasury, reducing total supply. |
| AC-8 | All admin setters revert for non-admin callers and for zero/invalid inputs. |
| AC-9 | A failed router swap does not revert the user's underlying transfer: the swap is caught, `swapping` is reset to `false`, and the transfer completes (FR-SWAP-7). |

---

## 7. Constraints, Assumptions & Open Items

### 7.1 Constraints
- Solidity `^0.8.20`; OpenZeppelin v5.x only.
- Built-in checked arithmetic (no `unchecked` blocks in tax math).

### 7.2 Assumptions
- The deployer is trusted at genesis and will configure treasury/yield vault
  before production trading.
- The treasury actively manages its allowance to the contract for burns.

### 7.3 Open Items / Known Gaps
| ID | Description | Severity | Status |
| --- | --- | --- | --- |
| OI-1 | FR-SWAP-7 `try/catch` failsafe. The router call is now wrapped in `try/catch` with `swapping` reset on both paths, so a router revert no longer freezes user transfers. | High | **Resolved (v1.1)** |
| OI-2 | `amountOutMin = 0` accepts unbounded slippage on the auto-swap; acceptable given small capped sizes, but should be monitored. | Medium | Open |
| OI-3 | `BPS_DENOMINATOR` visibility. Spec aligned to the implementation: it is intentionally `private` (no ABI getter needed for a static denominator). See FR-CFG-1. | Low | **Resolved (v1.1)** |

---

*End of document — SRS-BBA-001 v1.0*

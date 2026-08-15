# Smart Contract Implementation Plan: Dynamic Tax BEP20 Token

## 1. Project Overview
This project involves developing a BEP20 token smart contract with a fixed buy tax (3%) and a dynamic sell tax based on the 24-hour price drop percentage. The sell tax scales according to a specific tier list. All collected taxes are automatically swapped into USDT and sent to a specified tax receiver wallet.

## 2. Token Details (Demo Configuration)
*   **Token Name:** DemoToken
*   **Token Symbol:** DTK
*   **Total Supply:** 100,000,000 (100 Million)
*   **Decimals:** 18
*   **USDT Tax Receiver Wallet:** `0xc8Ba81002d9bf5229E6388c5320B37a7b2bd939A`

## 3. Core Contract Architecture
*   **Base Standards:** OpenZeppelin `ERC20`, `Ownable` (for `renounceOwnership`).
*   **Burnable:** Include `ERC20Burnable` or implement a standard `burn` function.
*   **DEX Integration:** 
    *   Interface `IPancakeRouter02` to handle swapping taxes.
    *   Interface `IPancakeFactory` to create the initial liquidity pair.
*   **Oracle Integration:** 
    *   Create an interface `IPriceOracle` with a function `get24hPriceDropPercentage()` that returns an integer (0-100). 
    *   *Agent Note:* Since a native 24h oracle for a brand new token does not exist on Chainlink, implement a modular interface that can be updated by an external authorized oracle wallet, or point to a TWAP implementation. For this contract, we need a setter `setOracleAddress(address)`.

## 4. Tax Mechanics & Logic

### Buy Tax
*   Fixed at **3%**.

### Dynamic Sell Tax (24h Price Drop Tier)
When a user sells (transfers to the PancakeSwap Pair), the contract must query `IPriceOracle` to get the current 24-hour price drop and apply the following tax rates:
*   0% - 5% Drop: **3% Tax**
*   6% Drop: **5% Tax**
*   7% Drop: **10% Tax**
*   8% Drop: **15% Tax**
*   9% Drop: **20% Tax**
*   10% Drop: **25% Tax**
*   11% Drop: **30% Tax**
*   12% Drop: **35% Tax**
*   13% Drop: **40% Tax**
*   14% Drop: **45% Tax**
*   15% Drop: **50% Tax**
*   16% Drop: **55% Tax**
*   17% Drop (or greater): **60% Tax**

*Agent Note:* Implement this using a helper function `getSellTaxRate(uint256 priceDrop)` to keep the `_transfer` function clean.

### Auto-Swap to USDT Logic (`swapAndSendUSDT`)
*   The contract will accumulate token taxes internally.
*   Upon reaching a specific `swapTokensAtAmount` threshold during a sell transaction, trigger an internal swap.
*   The swap path should be: `[address(this), WBNB, USDT_ADDRESS]`.
*   Send the resulting USDT directly to `0xc8Ba81002d9bf5229E6388c5320B37a7b2bd939A`.
*   Ensure a `swapping` boolean lock is used to prevent the `swapTokensForExactTokens` or `swapExactTokensForTokens` from triggering an infinite tax loop.

## 5. Implementation Steps for the Coding Agent

### Phase 1: Setup & Interfaces
1.  Initialize the Solidity file (Pragma `^0.8.20`).
2.  Import OpenZeppelin standard contracts (`ERC20`, `Ownable`).
3.  Define `IPancakeRouter02` and `IPriceOracle` interfaces.

### Phase 2: State Variables & Constructor
1.  Declare state variables: `pancakeV2Router`, `pancakeV2Pair`, `usdtAddress`, `taxReceiver`, `oracleAddress`, and `swapTokensAtAmount`.
2.  Create mappings for `_isExcludedFromFee`.
3.  In the constructor:
    *   Mint the total supply to `msg.sender`.
    *   Initialize the PancakeSwap router (BSC Mainnet: `0x10ED43C718714eb63d5aA57B78B54704E256024E`, Testnet: `0xD99D1c33F9fC3444f8101754aBC46c52416550D1`).
    *   Create the pair with WBNB.
    *   Set the USDT address (BSC Mainnet: `0x55d398326f99059fF775485246999027B3197955`).
    *   Exclude owner and contract from fees.

### Phase 3: Transfer & Tax Logic
1.  Override the `_update` or `_transfer` function.
2.  Implement checks: is the transaction a buy, sell, or standard transfer?
3.  If Buy (from pair to user): Apply 3% tax. Send tax to contract address.
4.  If Sell (from user to pair): 
    *   Check if `swapTokensAtAmount` is met and not currently swapping. If so, execute `swapBack()`.
    *   Query oracle for price drop.
    *   Calculate dynamic sell tax.
    *   Deduct tax and send to contract address.

### Phase 4: Swap Back Function
1.  Implement `swapBack()` using the `swapping` modifier.
2.  Approve router to spend tokens.
3.  Execute swap from DTK -> WBNB -> USDT.
4.  Transfer received USDT to `taxReceiver`.

## 6. Testing Strategy (Hardhat)
Agent must generate a test file (`test/DemoToken.test.js` or `.ts`) covering:
1.  **Deployment:** Verify correct supply, owner, and tax wallet configuration.
2.  **Oracle Mocking:** Deploy a mock oracle to manually manipulate the 24h price drop.
3.  **Tax Verification:**
    *   Mock 2% drop -> Verify 3% sell tax.
    *   Mock 10% drop -> Verify 25% sell tax.
    *   Mock 17% drop -> Verify 60% sell tax.
4.  **Auto-Swap:**
    *   Provide mock liquidity.
    *   Perform sells until the threshold is reached.
    *   Verify USDT balance of the tax receiver wallet increases.

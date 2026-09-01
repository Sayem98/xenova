// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IPancakeFactory, IPancakeRouter02} from "./interfaces/IPancake.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title Xenova
/// @notice BEP20 token with a fixed 3% buy tax and a sell tax that scales with
///         the 24-hour price drop reported by an external oracle. Trades against
///         USDT, so the drop the oracle reports is a dollar drop. Collected tax
///         is swapped to USDT through that same pair and forwarded to the tax
///         receiver.
contract Xenova is ERC20, ERC20Burnable, Ownable {
    uint256 public constant BUY_TAX_BPS = 300;
    uint256 public constant MAX_SELL_TAX_BPS = 6000;
    uint256 private constant BPS = 10_000;

    /// @dev A reading older than this is treated as no drop, so a dead oracle
    ///      degrades to the 3% floor rather than freezing sells at 60%.
    uint256 public constant ORACLE_STALE_AFTER = 2 hours;

    IPancakeRouter02 public immutable router;
    address public immutable usdt;

    address public taxReceiver;
    address public oracle;
    uint256 public swapTokensAtAmount;

    bool private _swapping;

    mapping(address => bool) public automatedMarketMakerPairs;
    mapping(address => bool) public isExcludedFromFee;

    event TaxReceiverUpdated(address indexed receiver);
    event OracleUpdated(address indexed oracle);
    event SwapTokensAtAmountUpdated(uint256 amount);
    event AutomatedMarketMakerPairUpdated(address indexed pair, bool value);
    event ExcludedFromFee(address indexed account, bool excluded);
    event TaxSwapped(uint256 tokensIn);
    event TaxSwapFailed(uint256 tokensIn);

    constructor(
        address router_,
        address usdt_,
        address taxReceiver_,
        address initialOwner_
    ) ERC20("Xenova", "Xenova") Ownable(initialOwner_) {
        require(router_ != address(0), "router is zero");
        require(usdt_ != address(0), "usdt is zero");
        require(taxReceiver_ != address(0), "receiver is zero");
        // initialOwner_ needs no zero-check here: Ownable's constructor runs
        // first and already reverts with OwnableInvalidOwner(address(0)).

        router = IPancakeRouter02(router_);
        usdt = usdt_;
        taxReceiver = taxReceiver_;

        uint256 supply = 210_000_000 * 10 ** decimals();
        // 0.05% of supply. Small enough to swap often without moving the price
        // much, large enough that the swap is not pure gas waste.
        swapTokensAtAmount = supply / 2000;

        // Paired against USDT, not WBNB: the oracle prices whatever this pair
        // holds, and a BNB-denominated price would move the sell tax every time
        // BNB moved, whether or not Xenova did.
        address pair = IPancakeFactory(router.factory()).createPair(
            address(this),
            usdt_
        );
        automatedMarketMakerPairs[pair] = true;
        emit AutomatedMarketMakerPairUpdated(pair, true);

        // The owner holds the supply and adds the liquidity, which sends tokens
        // to the pair — that classifies as a sell. Without this exclusion the
        // liquidity add would be taxed.
        isExcludedFromFee[initialOwner_] = true;
        isExcludedFromFee[address(this)] = true;

        _mint(initialOwner_, supply);
    }

    // -------------------------------------------------------------- tax math

    /// @notice Sell tax for a given 24h drop, in basis points.
    /// @dev Matches the tier table exactly: 0-5% drop -> 3%, 6% -> 5%, rising
    ///      5 points per additional 1% of drop, capped at 60% from 17% up.
    ///      The `rate < 300` floor is load-bearing: without it the linear term
    ///      starts near zero just above a 5% drop, so a 5.01% drop would be
    ///      taxed 0.05% — below the floor, and a seller could aim for it.
    function getSellTaxBps(uint256 dropBps) public pure returns (uint256) {
        if (dropBps <= 500) return 300;
        uint256 rate = (500 * (dropBps - 500)) / 100;
        if (rate < 300) rate = 300;
        return rate > MAX_SELL_TAX_BPS ? MAX_SELL_TAX_BPS : rate;
    }

    /// @dev Never reverts and never returns more than 10000, so a broken or
    ///      malicious oracle cannot freeze transfers or exceed the cap.
    function currentDropBps() public view returns (uint256) {
        address oracle_ = oracle;
        if (oracle_ == address(0)) return 0;

        try IPriceOracle(oracle_).get24hPriceDropBps() returns (
            uint256 dropBps,
            uint256 updatedAt
        ) {
            if (block.timestamp - updatedAt > ORACLE_STALE_AFTER) return 0;
            return dropBps > BPS ? BPS : dropBps;
        } catch {
            return 0;
        }
    }

    // -------------------------------------------------------------- transfers

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        if (
            from == address(0) ||
            to == address(0) ||
            _swapping ||
            isExcludedFromFee[from] ||
            isExcludedFromFee[to]
        ) {
            super._update(from, to, value);
            return;
        }

        uint256 taxBps;

        if (automatedMarketMakerPairs[to]) {
            // Sell. Swap back here and not on buys: during a buy the pair is
            // inside its own swap() and holds the reentrancy lock, so routing
            // from there reverts with "Pancake: LOCKED".
            if (balanceOf(address(this)) >= swapTokensAtAmount) {
                _swapBack();
            }
            taxBps = getSellTaxBps(currentDropBps());
        } else if (automatedMarketMakerPairs[from]) {
            taxBps = BUY_TAX_BPS;
        }

        if (taxBps != 0) {
            uint256 fee = (value * taxBps) / BPS;
            if (fee != 0) {
                super._update(from, address(this), fee);
                value -= fee;
            }
        }

        super._update(from, to, value);
    }

    /// @dev Swaps one threshold at a time to limit price impact. Wrapped in
    ///      try/catch so an illiquid pool cannot brick every transfer — the
    ///      accrued tax simply carries to the next trigger.
    function _swapBack() private {
        uint256 amount = swapTokensAtAmount;

        _swapping = true;

        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = usdt;

        _approve(address(this), address(router), amount);

        try
            router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amount,
                0,
                path,
                taxReceiver,
                block.timestamp
            )
        {
            emit TaxSwapped(amount);
        } catch {
            emit TaxSwapFailed(amount);
        }

        _swapping = false;
    }

    // ----------------------------------------------------------------- admin

    function setTaxReceiver(address receiver) external onlyOwner {
        require(receiver != address(0), "receiver is zero");
        taxReceiver = receiver;
        emit TaxReceiverUpdated(receiver);
    }

    function setOracle(address oracle_) external onlyOwner {
        oracle = oracle_;
        emit OracleUpdated(oracle_);
    }

    function setSwapTokensAtAmount(uint256 amount) external onlyOwner {
        require(amount != 0, "amount is zero");
        swapTokensAtAmount = amount;
        emit SwapTokensAtAmountUpdated(amount);
    }

    function setAutomatedMarketMakerPair(
        address pair,
        bool value
    ) external onlyOwner {
        automatedMarketMakerPairs[pair] = value;
        emit AutomatedMarketMakerPairUpdated(pair, value);
    }

    function setExcludedFromFee(
        address account,
        bool excluded
    ) external onlyOwner {
        isExcludedFromFee[account] = excluded;
        emit ExcludedFromFee(account, excluded);
    }
}

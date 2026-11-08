// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPancakePair} from "../interfaces/IPancake.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @title XenovaTwapOracle
/// @notice Reports the 24-hour price drop of a token against its AMM pair,
///         measured the way a DEX chart reports it: the price now against the
///         price 24 hours ago.
///
/// @dev Both ends of the comparison are time-weighted averages over at least
///      10 minutes, not spot prices. A flash loan lives for one transaction and
///      so cannot move either figure; faking a 0% drop means holding the price
///      up for 10 minutes across many blocks.
///
///      Note this is deliberately NOT "price now vs. the 24-hour average". Those
///      differ sharply when the drop happened earlier in the window. A token at
///      $1.25 that fell to $1.00 twenty-three hours ago and stayed there reads
///      -20% here and on a DEX chart, but only -1% against a 24-hour average.
contract XenovaTwapOracle is IPriceOracle {
    uint256 public constant PERIOD = 10 minutes;
    /// @dev 24h / 10 min = 144 periods, plus 2 = 146 slots (24h20m). The two
    ///      extra slots are what make the "24 hours ago" window available: it
    ///      needs two stored observations, 144 and 145 slots back. Derived from
    ///      PERIOD so the two cannot drift apart. PERIOD must divide 24 hours
    ///      evenly: the division rounds down silently, which would shorten the
    ///      lookback to less than 24h.
    uint256 public constant SLOTS = 24 hours / PERIOD + 2;

    struct Observation {
        uint256 priceCumulative;
        uint256 timestamp;
    }

    IPancakePair public immutable pair;
    /// @dev Fixed at construction so the accumulator side never has to be
    ///      re-derived: token0 and token1 are immutable on a V2 pair.
    bool public immutable tokenIsToken0;

    Observation[SLOTS] public observations;
    /// @notice Index of the newest observation.
    uint256 public head;
    /// @notice Total updates ever recorded. Used for the cold-start check.
    uint256 public count;

    event Updated(uint256 indexed index, uint256 priceCumulative, uint256 timestamp);

    constructor(address pair_, address token_) {
        require(pair_ != address(0), "pair is zero");
        pair = IPancakePair(pair_);

        address token0 = IPancakePair(pair_).token0();
        address token1 = IPancakePair(pair_).token1();
        require(token_ == token0 || token_ == token1, "token not in pair");
        tokenIsToken0 = token_ == token0;

        _record();
    }

    // ---------------------------------------------------------------- keeper

    /// @notice Records the pair's current cumulative price. Permissionless: the
    ///         caller cannot choose the value, only whether to call at all.
    /// @dev Refusing to call degrades to a stale reading, which consumers treat
    ///      as no drop. It cannot be used to report a *higher* drop.
    function update() external {
        require(
            block.timestamp - observations[head].timestamp >= PERIOD,
            "too soon"
        );
        _record();
    }

    function _record() private {
        (uint256 cumulative, ) = currentCumulativePrice();

        uint256 index = count == 0 ? 0 : (head + 1) % SLOTS;
        observations[index] = Observation({
            priceCumulative: cumulative,
            timestamp: block.timestamp
        });

        head = index;
        count += 1;

        emit Updated(index, cumulative, block.timestamp);
    }

    // ----------------------------------------------------------------- reads

    /// @inheritdoc IPriceOracle
    function get24hPriceDropBps()
        external
        view
        returns (uint256 dropBps, uint256 updatedAt)
    {
        updatedAt = observations[head].timestamp;

        // Cold start: a new token has no history. Report no drop until the
        // buffer reaches back a full 24h plus the 10 minutes before it.
        if (count < SLOTS) return (0, updatedAt);

        // The "24 hours ago" window: a completed 10-minute span, 144-145 slots
        // back.
        Observation memory thenStart = observations[(head + 1) % SLOTS];
        Observation memory thenEnd = observations[(head + 2) % SLOTS];

        // The "now" window starts one slot back, not at `head`. Starting at
        // `head` would give a zero-length window in the same block as a keeper
        // update — `_twap` returns 0, and the drop computes as a full 100%.
        // Going one further back guarantees at least PERIOD of span, since
        // update() enforces that spacing.
        Observation memory nowStart = observations[(head + SLOTS - 1) % SLOTS];

        (uint256 cumulativeNow, ) = currentCumulativePrice();

        uint256 twapThen = _twap(
            thenStart,
            thenEnd.priceCumulative,
            thenEnd.timestamp
        );
        uint256 twapNow = _twap(nowStart, cumulativeNow, block.timestamp);

        if (twapThen == 0 || twapNow >= twapThen) return (0, updatedAt);

        dropBps = ((twapThen - twapNow) * 10_000) / twapThen;
        if (dropBps > 10_000) dropBps = 10_000;
    }

    /// @dev Average price over [start, end], in UQ112x112. The fixed-point
    ///      scaling cancels when two of these are divided, so callers can treat
    ///      the result as a plain ratio.
    function _twap(
        Observation memory start,
        uint256 endCumulative,
        uint256 endTimestamp
    ) private pure returns (uint256) {
        if (endTimestamp <= start.timestamp) return 0;
        unchecked {
            // Wrapping is expected: V2 accumulators are designed to overflow,
            // and the difference stays correct across the wrap.
            return
                (endCumulative - start.priceCumulative) /
                (endTimestamp - start.timestamp);
        }
    }

    /// @notice The pair's cumulative price, extrapolated to the current block.
    /// @dev Without the extrapolation the accumulator is stale between trades,
    ///      so a quiet pair would report a frozen price.
    function currentCumulativePrice()
        public
        view
        returns (uint256 cumulative, uint32 timestamp)
    {
        timestamp = uint32(block.timestamp);

        cumulative = tokenIsToken0
            ? pair.price0CumulativeLast()
            : pair.price1CumulativeLast();

        (uint112 reserve0, uint112 reserve1, uint32 lastTimestamp) = pair
            .getReserves();

        if (reserve0 == 0 || reserve1 == 0) return (cumulative, timestamp);

        if (lastTimestamp != timestamp) {
            uint32 elapsed;
            unchecked {
                elapsed = timestamp - lastTimestamp;
            }
            uint224 price = tokenIsToken0
                ? _fraction(reserve1, reserve0)
                : _fraction(reserve0, reserve1);
            unchecked {
                cumulative += uint256(price) * elapsed;
            }
        }
    }

    /// @dev UQ112x112 division, matching Uniswap V2's fixed-point encoding.
    function _fraction(
        uint112 numerator,
        uint112 denominator
    ) private pure returns (uint224) {
        return (uint224(numerator) << 112) / denominator;
    }
}

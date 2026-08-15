// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal Uniswap/Pancake V2 pair stub that accumulates price exactly
///         the way a real pair does, so oracle tests exercise the real maths.
contract MockPair {
    address public token0;
    address public token1;

    uint112 private _reserve0;
    uint112 private _reserve1;
    uint32 private _blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function getReserves()
        external
        view
        returns (uint112, uint112, uint32)
    {
        return (_reserve0, _reserve1, _blockTimestampLast);
    }

    /// @dev Mirrors UniswapV2Pair._update: fold the *old* price into the
    ///      accumulator for the elapsed time, then store the new reserves.
    function setReserves(uint112 reserve0_, uint112 reserve1_) external {
        uint32 timestamp = uint32(block.timestamp);
        uint32 elapsed;
        unchecked {
            elapsed = timestamp - _blockTimestampLast;
        }

        if (elapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
            unchecked {
                price0CumulativeLast +=
                    uint256(_fraction(_reserve1, _reserve0)) *
                    elapsed;
                price1CumulativeLast +=
                    uint256(_fraction(_reserve0, _reserve1)) *
                    elapsed;
            }
        }

        _reserve0 = reserve0_;
        _reserve1 = reserve1_;
        _blockTimestampLast = timestamp;
    }

    function _fraction(
        uint112 numerator,
        uint112 denominator
    ) private pure returns (uint224) {
        return (uint224(numerator) << 112) / denominator;
    }
}

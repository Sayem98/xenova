// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPriceOracle {
    /// @notice 24-hour price drop, measured the way a DEX chart reports it:
    ///         the price now against the price 24 hours ago.
    /// @return dropBps   drop in basis points, 0..10000. Never negative — a
    ///                   price that rose over 24h reports 0.
    /// @return updatedAt timestamp of the most recent keeper update, so callers
    ///                   can tell a genuine 0% drop from a dead oracle.
    function get24hPriceDropBps()
        external
        view
        returns (uint256 dropBps, uint256 updatedAt);
}

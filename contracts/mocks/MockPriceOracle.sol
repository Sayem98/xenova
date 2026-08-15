// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice Oracle stub for token tests. Lets a test drive the reported drop
///         directly, including the misbehaving cases the token must survive:
///         a reverting oracle, an out-of-range value, and a stale reading.
contract MockPriceOracle is IPriceOracle {
    uint256 public dropBps;
    uint256 public updatedAt;
    bool public shouldRevert;

    constructor() {
        updatedAt = block.timestamp;
    }

    function setDrop(uint256 dropBps_) external {
        dropBps = dropBps_;
        updatedAt = block.timestamp;
    }

    /// @dev Sets the value without refreshing `updatedAt`, so the reading can be
    ///      aged past the consumer's staleness window.
    function setDropWithTimestamp(
        uint256 dropBps_,
        uint256 updatedAt_
    ) external {
        dropBps = dropBps_;
        updatedAt = updatedAt_;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function get24hPriceDropBps()
        external
        view
        returns (uint256, uint256)
    {
        require(!shouldRevert, "oracle down");
        return (dropBps, updatedAt);
    }
}

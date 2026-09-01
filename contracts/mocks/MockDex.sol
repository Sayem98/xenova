// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockPair} from "./MockPair.sol";

contract MockERC20 is ERC20 {
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply
    ) ERC20(name_, symbol_) {
        _mint(msg.sender, supply);
    }
}

contract MockFactory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(
        address tokenA,
        address tokenB
    ) external returns (address pair) {
        pair = address(new MockPair(tokenA, tokenB));
        getPair[tokenA][tokenB] = pair;
        getPair[tokenB][tokenA] = pair;
    }
}

/// @notice Router stub. Swaps at a fixed rate so tests can assert the tax
///         actually lands as USDT at the receiver.
/// @dev Deliberately does NOT enforce the constant-product K invariant, which is
///      why the plan requires a fork test for the `Pancake: K` behaviour — a
///      mock router cannot reproduce it.
contract MockRouter {
    address public immutable factory;

    uint256 public rate = 1e18;
    bool public shouldRevert;

    constructor(address factory_) {
        factory = factory_;
    }

    function setRate(uint256 rate_) external {
        rate = rate_;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256,
        address[] calldata path,
        address to,
        uint256
    ) external {
        require(!shouldRevert, "router down");

        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

        uint256 amountOut = (amountIn * rate) / 1e18;
        IERC20(path[path.length - 1]).transfer(to, amountOut);
    }
}

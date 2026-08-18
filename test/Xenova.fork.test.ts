import { expect } from "chai";
import { ethers } from "hardhat";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

/// Fork tests against real BSC mainnet contracts. These are the only tests that
/// exercise a genuine PancakeSwap pair, and so the only ones that can reproduce
/// the fee-on-transfer behaviour a mock router cannot — implementation_plan.md
/// §7 items 12 and 21.
///
///   yarn test:fork
///
/// The public dataseed keeps only ~100 blocks of state, so this forks at the
/// latest block and must not pin FORK_BLOCK to anything older.
const FORKING = process.env.FORK_BSC === "true";

const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";

const ROUTER_ABI = [
  "function addLiquidityETH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[])",
];

const deadline = () => Math.floor(Date.now() / 1000) + 3600;

(FORKING ? describe : describe.skip)("Xenova — BSC mainnet fork", () => {
  async function launch() {
    const [owner, trader, taxReceiver] = await ethers.getSigners();

    await setBalance(owner.address, ethers.parseEther("1000"));
    await setBalance(trader.address, ethers.parseEther("1000"));

    const token = await (
      await ethers.getContractFactory("Xenova")
    ).deploy(ROUTER, USDT, taxReceiver.address, owner.address);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();

    // `any`: this is a hand-rolled ABI, so ethers types it as a bare
    // BaseContract and connect() would drop every method signature.
    const router: any = new ethers.Contract(ROUTER, ROUTER_ABI, owner);

    // A real pool: 10,000,000 Xenova against 100 BNB.
    const lpTokens = ethers.parseEther("10000000");
    await (await token.approve(ROUTER, lpTokens)).wait();
    await (
      await router.addLiquidityETH(
        tokenAddress,
        lpTokens,
        0,
        0,
        owner.address,
        deadline(),
        { value: ethers.parseEther("100") }
      )
    ).wait();

    const oracle = await (
      await ethers.getContractFactory("MockPriceOracle")
    ).deploy();
    await (await token.setOracle(await oracle.getAddress())).wait();

    return { owner, trader, taxReceiver, token, tokenAddress, router, oracle };
  }

  /// Buys `bnb` worth of Xenova for the trader through the real router.
  async function buy(ctx: any, bnb: string): Promise<bigint> {
    const router = ctx.router.connect(ctx.trader);
    const before: bigint = await ctx.token.balanceOf(ctx.trader.address);
    await (
      await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
        0,
        [WBNB, ctx.tokenAddress],
        ctx.trader.address,
        deadline(),
        { value: ethers.parseEther(bnb) }
      )
    ).wait();
    return (await ctx.token.balanceOf(ctx.trader.address)) - before;
  }

  it("takes 3% on a real PancakeSwap buy", async () => {
    const ctx = await launch();
    const router = ctx.router.connect(ctx.trader);

    const quoted = await router.getAmountsOut(ethers.parseEther("1"), [
      WBNB,
      ctx.tokenAddress,
    ]);
    const expectedBeforeTax = quoted[1];

    const received = await buy(ctx, "1");

    // The router's quote ignores the tax, so the trader lands 3% short of it.
    const expected = (expectedBeforeTax * 9700n) / 10000n;
    expect(received).to.be.closeTo(expected, expected / 1000n);

    // The 3% is sitting in the token contract awaiting swap-back.
    expect(await ctx.token.balanceOf(ctx.tokenAddress)).to.be.greaterThan(0n);
  });

  it("takes the tier rate on a real sell", async () => {
    const ctx = await launch();
    await ctx.oracle.setDrop(1000); // 10% drop -> 25% tax

    // Park the threshold out of reach so swap-back cannot fire and drain the
    // contract mid-test. This isolates the fee arithmetic exactly.
    await (
      await ctx.token.setSwapTokensAtAmount(ethers.parseEther("100000000"))
    ).wait();

    const bought = await buy(ctx, "1");
    const accruedBefore = await ctx.token.balanceOf(ctx.tokenAddress);

    const sellAmount = bought / 2n;
    await (
      await ctx.token.connect(ctx.trader).approve(ROUTER, sellAmount)
    ).wait();
    await (
      await ctx.router
        .connect(ctx.trader)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          sellAmount,
          0,
          [ctx.tokenAddress, WBNB],
          ctx.trader.address,
          deadline()
        )
    ).wait();

    const accruedAfter = await ctx.token.balanceOf(ctx.tokenAddress);
    expect(accruedAfter - accruedBefore).to.equal((sellAmount * 2500n) / 10000n);
  });

  // ---------------------------------------------------- §7 item 12: Pancake: K

  it("reverts with Pancake: K when a seller uses the non-fee-supporting swap", async () => {
    const ctx = await launch();
    await ctx.oracle.setDrop(0); // even at the 3% floor

    const bought = await buy(ctx, "1");
    const sellAmount = bought / 2n;
    await (
      await ctx.token.connect(ctx.trader).approve(ROUTER, sellAmount)
    ).wait();

    // swapExactTokensForETH computes the output up front and tells the pair to
    // send exactly that. The pair receives 3% less than promised, so its K check
    // fails. This is the revert the README's Known Limitation is about.
    await expect(
      ctx.router
        .connect(ctx.trader)
        .swapExactTokensForETH(
          sellAmount,
          0,
          [ctx.tokenAddress, WBNB],
          ctx.trader.address,
          deadline()
        )
    ).to.be.revertedWith("Pancake: K");
  });

  it("rejects a sell whose slippage does not cover the tax", async () => {
    const ctx = await launch();
    await ctx.oracle.setDrop(1700); // 60% tax, the top tier

    const bought = await buy(ctx, "1");
    const sellAmount = bought / 2n;
    await (
      await ctx.token.connect(ctx.trader).approve(ROUTER, sellAmount)
    ).wait();

    // What the UI would quote, ignoring the tax entirely.
    const quoted = await ctx.router.getAmountsOut(sellAmount, [
      ctx.tokenAddress,
      WBNB,
    ]);
    // A seller who sets 49% slippage — the most PancakeSwap's UI allows.
    const amountOutMin = (quoted[1] * 5100n) / 10000n;

    await expect(
      ctx.router
        .connect(ctx.trader)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          sellAmount,
          amountOutMin,
          [ctx.tokenAddress, WBNB],
          ctx.trader.address,
          deadline()
        )
    ).to.be.revertedWith("PancakeRouter: INSUFFICIENT_OUTPUT_AMOUNT");
  });

  it("allows the same 60% sell when slippage is set high enough", async () => {
    const ctx = await launch();
    await ctx.oracle.setDrop(1700);

    const bought = await buy(ctx, "1");
    const sellAmount = bought / 2n;
    await (
      await ctx.token.connect(ctx.trader).approve(ROUTER, sellAmount)
    ).wait();

    // Proves the contract is not a honeypot: the tokens are sellable at 60%,
    // it is only PancakeSwap's UI slippage cap that blocks a normal user.
    await expect(
      ctx.router
        .connect(ctx.trader)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          sellAmount,
          0,
          [ctx.tokenAddress, WBNB],
          ctx.trader.address,
          deadline()
        )
    ).to.not.be.reverted;
  });

  // --------------------------------------------- §7 item 21: real USDT payout

  it("swaps accrued tax to real 18-decimal USDT and pays the receiver", async () => {
    const ctx = await launch();
    await ctx.oracle.setDrop(1000);

    const usdt = new ethers.Contract(
      USDT,
      [
        "function balanceOf(address) view returns (uint256)",
        "function decimals() view returns (uint8)",
      ],
      ethers.provider
    );

    // The assumption the whole USDT-side of this project rests on. BSC USDT is
    // 18 decimals; the Ethereum one is 6, and getting this wrong is a 10^12 error.
    expect(await usdt.decimals()).to.equal(18n);

    // Small threshold so one sell crosses it.
    await (
      await ctx.token.setSwapTokensAtAmount(ethers.parseEther("1000"))
    ).wait();

    // Not asserted to be zero: on a mainnet fork these signer addresses are real
    // accounts and may already hold a dust balance of USDT.
    const before = await usdt.balanceOf(ctx.taxReceiver.address);

    // Buy, then sell twice: the first accrues past the threshold, the second
    // triggers the swap-back (swap-back only runs on sells).
    const bought = await buy(ctx, "5");
    await (await ctx.token.connect(ctx.trader).approve(ROUTER, bought)).wait();

    for (const part of [bought / 4n, bought / 4n]) {
      await (
        await ctx.router
          .connect(ctx.trader)
          .swapExactTokensForETHSupportingFeeOnTransferTokens(
            part,
            0,
            [ctx.tokenAddress, WBNB],
            ctx.trader.address,
            deadline()
          )
      ).wait();
    }

    const after = await usdt.balanceOf(ctx.taxReceiver.address);
    const paid = after - before;
    expect(paid).to.be.greaterThan(0n);
    // Sanity on scale: the swapped tax is worth real money, so at 18 decimals it
    // lands far above 1e12 wei. A 6-decimal token would land ~10^12 lower.
    expect(paid).to.be.greaterThan(ethers.parseUnits("1", 15));
  });
});

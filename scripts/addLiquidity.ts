import { ethers, network } from "hardhat";

import { addressesFor, pairFor } from "./addresses";

/// Seeds the Xenova/USDT pool. Run after scripts/deploy.ts and before
/// scripts/deployOracle.ts, which refuses to run against an empty pool.
///
///   TOKEN_ADDRESS=0x… npx hardhat run scripts/addLiquidity.ts --network bscTestnet
///
/// Amounts default to the testnet rehearsal size and are overridable:
///   LP_TOKENS=5000000 LP_USDT=500
///
/// The USDT side comes out of the owner wallet, so hold it before running this.
/// On testnet, scripts/deployMockUsdt.ts mints you as much as you want.
///
/// Must be signed by the owner — it is the only address holding tokens, and the
/// only one excluded from fees. That exclusion is what makes this work: sending
/// tokens to the pair is otherwise classified as a sell and taxed, so the router
/// would receive less than it was promised and revert with "Pancake: K".

/// addLiquidity is not in contracts/interfaces/IPancake.sol and does not need to
/// be — the token never calls it, only this script does.
const ROUTER_ABI = [
  "function addLiquidity(address tokenA,address tokenB,uint256 amountADesired,uint256 amountBDesired,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline) returns (uint256 amountA,uint256 amountB,uint256 liquidity)",
];

async function main() {
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    throw new Error("Set TOKEN_ADDRESS to the deployed Xenova address.");
  }

  const { router, usdt } = addressesFor(network.name);

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY in .env.");
  }

  const token = await ethers.getContractAt("Xenova", tokenAddress);

  const owner = await token.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Liquidity must be added by the owner (it holds the supply and is the ` +
        `only fee-excluded address). Owner is ${owner}, signer is ` +
        `${signer.address}.`
    );
  }

  // The pool size only affects price impact, not whether any of the tax logic
  // works, so the testnet default is deliberately small. On mainnet there is no
  // sensible default — this spends real USDT — so both must be given explicitly.
  if (network.name === "bsc" && !(process.env.LP_TOKENS && process.env.LP_USDT)) {
    throw new Error(
      "Set LP_TOKENS and LP_USDT explicitly for a mainnet liquidity add. " +
        "There is no safe default for a real pool."
    );
  }

  // Both sides are 18 decimals on BSC, so parseEther is right for USDT too.
  const tokens = ethers.parseEther(process.env.LP_TOKENS || "1000000");
  const usdtAmount = ethers.parseEther(process.env.LP_USDT || "1000");

  const tokenBalance = await token.balanceOf(signer.address);
  if (tokenBalance < tokens) {
    throw new Error(
      `Need ${ethers.formatEther(tokens)} Xenova but the owner holds ` +
        `${ethers.formatEther(tokenBalance)}.`
    );
  }

  const usdtToken = await ethers.getContractAt("IERC20", usdt);
  const usdtBalance = await usdtToken.balanceOf(signer.address);
  if (usdtBalance < usdtAmount) {
    throw new Error(
      `Need ${ethers.formatEther(usdtAmount)} USDT but the owner holds ` +
        `${ethers.formatEther(usdtBalance)} at ${usdt}. Lower LP_USDT, or on ` +
        `testnet run scripts/deployMockUsdt.ts and set TESTNET_USDT.`
    );
  }

  // Gas only — the liquidity itself is USDT now, not BNB.
  const bnbBalance = await ethers.provider.getBalance(signer.address);
  if (bnbBalance === 0n) {
    throw new Error(
      `${signer.address} has no BNB for gas. Fund it from a faucet.`
    );
  }

  if (!(await token.isExcludedFromFee(signer.address))) {
    throw new Error(
      `${signer.address} is not fee-excluded — the liquidity add would be ` +
        `taxed and revert with "Pancake: K". Call setExcludedFromFee first.`
    );
  }

  console.log(`network   ${network.name}`);
  console.log(`token     ${tokenAddress}`);
  console.log(`usdt      ${usdt}`);
  console.log(`owner     ${signer.address}`);
  console.log(
    `adding    ${ethers.formatEther(tokens)} Xenova + ` +
      `${ethers.formatEther(usdtAmount)} USDT`
  );
  console.log("");

  const approveTx = await token.approve(router, tokens);
  await approveTx.wait();
  console.log(`approve   ${approveTx.hash}`);

  // Both sides are ERC20s now, so the router needs an allowance for each.
  const approveUsdtTx = await usdtToken.connect(signer).approve(router, usdtAmount);
  await approveUsdtTx.wait();
  console.log(`approveU  ${approveUsdtTx.hash}`);

  const routerContract = new ethers.Contract(router, ROUTER_ABI, signer);
  const deadline = Math.floor(Date.now() / 1000) + 20 * 60;

  // amountAMin / amountBMin are 0 because the pool is empty on the first add —
  // there is no existing ratio to slip against, and we are the only one adding.
  // Do not copy this into a script that tops up an existing pool.
  const addTx = await routerContract.addLiquidity(
    tokenAddress,
    usdt,
    tokens,
    usdtAmount,
    0,
    0,
    signer.address,
    deadline
  );
  await addTx.wait();
  console.log(`addLiq    ${addTx.hash}`);
  console.log("");

  const pairAddress = await pairFor(ethers, router, tokenAddress, usdt);
  const pair = await ethers.getContractAt("IPancakePair", pairAddress);
  const [reserve0, reserve1] = await pair.getReserves();
  const token0 = await pair.token0();
  const xenovaIsToken0 =
    token0.toLowerCase() === tokenAddress.toLowerCase();

  console.log(`pair      ${pairAddress}`);
  console.log(
    `reserves  ${ethers.formatEther(xenovaIsToken0 ? reserve0 : reserve1)} Xenova / ` +
      `${ethers.formatEther(xenovaIsToken0 ? reserve1 : reserve0)} USDT`
  );
  console.log("");
  console.log("Next: lower the swap-back threshold so a test-sized trade can");
  console.log("reach it (it defaults to 105,000 Xenova), then wire an oracle:");
  console.log(
    `  npx hardhat console --network ${network.name}`
  );
  console.log(
    `  > const t = await ethers.getContractAt("Xenova", "${tokenAddress}")`
  );
  console.log(`  > await t.setSwapTokensAtAmount(ethers.parseEther("100"))`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { ethers, network } from "hardhat";

import { addressesFor, pairFor } from "./addresses";

/// Seeds the Xenova/WBNB pool. Run after scripts/deploy.ts and before
/// scripts/deployOracle.ts, which refuses to run against an empty pool.
///
///   TOKEN_ADDRESS=0x… npx hardhat run scripts/addLiquidity.ts --network bscTestnet
///
/// Amounts default to the testnet rehearsal size and are overridable:
///   LP_TOKENS=5000000 LP_BNB=0.5
///
/// Must be signed by the owner — it is the only address holding tokens, and the
/// only one excluded from fees. That exclusion is what makes this work: sending
/// tokens to the pair is otherwise classified as a sell and taxed, so the router
/// would receive less than it was promised and revert with "Pancake: K".

/// addLiquidityETH is not in contracts/interfaces/IPancake.sol and does not need
/// to be — the token never calls it, only this script does.
const ROUTER_ABI = [
  "function addLiquidityETH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) payable returns (uint256 amountToken,uint256 amountETH,uint256 liquidity)",
];

async function main() {
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    throw new Error("Set TOKEN_ADDRESS to the deployed Xenova address.");
  }

  const { router } = addressesFor(network.name);

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

  // Testnet defaults are deliberately small — BSC testnet faucets drip roughly
  // 0.1 BNB at a time, and the pool size only affects price impact, not whether
  // any of the tax logic works. On mainnet there is no sensible default, so both
  // must be given explicitly rather than risking a wrong-sized real pool.
  if (network.name === "bsc" && !(process.env.LP_TOKENS && process.env.LP_BNB)) {
    throw new Error(
      "Set LP_TOKENS and LP_BNB explicitly for a mainnet liquidity add. " +
        "There is no safe default for a real pool."
    );
  }

  const tokens = ethers.parseEther(process.env.LP_TOKENS || "1000000");
  const bnb = ethers.parseEther(process.env.LP_BNB || "0.05");

  const tokenBalance = await token.balanceOf(signer.address);
  if (tokenBalance < tokens) {
    throw new Error(
      `Need ${ethers.formatEther(tokens)} Xenova but the owner holds ` +
        `${ethers.formatEther(tokenBalance)}.`
    );
  }

  const bnbBalance = await ethers.provider.getBalance(signer.address);
  if (bnbBalance <= bnb) {
    throw new Error(
      `Need ${ethers.formatEther(bnb)} BNB for liquidity plus gas, but the ` +
        `owner holds ${ethers.formatEther(bnbBalance)}. Fund it from a faucet ` +
        `or lower LP_BNB.`
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
  console.log(`owner     ${signer.address}`);
  console.log(`adding    ${ethers.formatEther(tokens)} Xenova + ${ethers.formatEther(bnb)} BNB`);
  console.log("");

  const approveTx = await token.approve(router, tokens);
  await approveTx.wait();
  console.log(`approve   ${approveTx.hash}`);

  const routerContract = new ethers.Contract(router, ROUTER_ABI, signer);
  const deadline = Math.floor(Date.now() / 1000) + 20 * 60;

  // amountTokenMin / amountETHMin are 0 because the pool is empty on the first
  // add — there is no existing ratio to slip against, and we are the only one
  // adding. Do not copy this into a script that tops up an existing pool.
  const addTx = await routerContract.addLiquidityETH(
    tokenAddress,
    tokens,
    0,
    0,
    signer.address,
    deadline,
    { value: bnb }
  );
  await addTx.wait();
  console.log(`addLiq    ${addTx.hash}`);
  console.log("");

  const pairAddress = await pairFor(ethers, router, tokenAddress);
  const pair = await ethers.getContractAt("IPancakePair", pairAddress);
  const [reserve0, reserve1] = await pair.getReserves();
  const token0 = await pair.token0();
  const xenovaIsToken0 =
    token0.toLowerCase() === tokenAddress.toLowerCase();

  console.log(`pair      ${pairAddress}`);
  console.log(
    `reserves  ${ethers.formatEther(xenovaIsToken0 ? reserve0 : reserve1)} Xenova / ` +
      `${ethers.formatEther(xenovaIsToken0 ? reserve1 : reserve0)} WBNB`
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

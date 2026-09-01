import { ethers, network } from "hardhat";

import { assertTestnetOnly } from "./addresses";

/// Testnet step 0. Deploys a USDT stand-in you can mint freely, because the
/// pool now needs USDT on both sides of the launch and testnet faucets do not
/// hand it out.
///
///   npx hardhat run scripts/deployMockUsdt.ts --network bscTestnet
///
/// Put the printed address in TESTNET_USDT before running scripts/deploy.ts —
/// the token bakes the USDT address into its constructor, so changing it later
/// means redeploying the token.
///
/// Real BSC USDT has 18 decimals, and so does MockERC20. That is what keeps
/// `parseEther` the right unit on both networks.
const SUPPLY = process.env.MOCK_USDT_SUPPLY || "10000000";

async function main() {
  assertTestnetOnly(network.name, "Mock USDT");

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY in .env.");
  }

  const supply = ethers.parseEther(SUPPLY);
  const usdt = await (
    await ethers.getContractFactory("MockERC20")
  ).deploy("Tether USD", "USDT", supply);
  await usdt.waitForDeployment();

  const address = await usdt.getAddress();

  console.log(`network   ${network.name}`);
  console.log(`mock USDT ${address}`);
  console.log(`minted    ${ethers.formatEther(supply)} to ${signer.address}`);
  console.log("");
  console.log("Add this to .env, then deploy the token:");
  console.log(`  TESTNET_USDT=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

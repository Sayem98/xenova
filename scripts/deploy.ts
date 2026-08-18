import { ethers, network } from "hardhat";

import { OWNER, addressesFor } from "./addresses";

/// Step 1 of the launch: deploy the token itself.
///
///   npx hardhat run scripts/deploy.ts --network bscTestnet
///
/// Ownership and the full supply go to OWNER in this transaction — the deploy
/// key ends up holding nothing and controlling nothing. Liquidity must then be
/// added from the OWNER wallet, after which scripts/deployOracle.ts wires up
/// the price feed.
async function main() {
  const { router, usdt } = addressesFor(network.name);
  const taxReceiver = process.env.TAX_RECEIVER || OWNER;

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY in .env.");
  }

  console.log(`network      ${network.name}`);
  console.log(`deployer     ${deployer.address}`);
  console.log(`router       ${router}`);
  console.log(`usdt         ${usdt}`);
  console.log(`taxReceiver  ${taxReceiver}`);
  console.log(`owner        ${OWNER}`);
  console.log("");

  const token = await (
    await ethers.getContractFactory("Xenova")
  ).deploy(router, usdt, taxReceiver, OWNER);
  await token.waitForDeployment();

  const address = await token.getAddress();

  // Read the state back from the chain rather than trusting the arguments we
  // just sent — this is the check that the supply really landed on OWNER.
  const supply = await token.totalSupply();
  const factory = await ethers.getContractAt(
    "IPancakeFactory",
    await (await ethers.getContractAt("IPancakeRouter02", router)).factory()
  );
  const weth = await (
    await ethers.getContractAt("IPancakeRouter02", router)
  ).WETH();
  const pair = await factory.getPair(address, weth);

  console.log(`Xenova       ${address}`);
  console.log(`pair         ${pair}`);
  console.log(`name/symbol  ${await token.name()} / ${await token.symbol()}`);
  console.log(`totalSupply  ${ethers.formatEther(supply)}`);
  console.log(`owner        ${await token.owner()}`);
  console.log(`owner holds  ${ethers.formatEther(await token.balanceOf(OWNER))}`);
  console.log(
    `swap at      ${ethers.formatEther(await token.swapTokensAtAmount())}`
  );
  console.log("");
  console.log("Verify with:");
  console.log(
    `  npx hardhat verify --network ${network.name} ${address} ` +
      `"${router}" "${usdt}" "${taxReceiver}" "${OWNER}"`
  );
  console.log("");
  console.log("Next: add liquidity from the OWNER wallet, then run");
  console.log(
    `  TOKEN_ADDRESS=${address} npx hardhat run scripts/deployOracle.ts --network ${network.name}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

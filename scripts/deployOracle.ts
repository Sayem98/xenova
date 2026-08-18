import { ethers, network } from "hardhat";

import { addressesFor, pairFor } from "./addresses";

/// Step 2 of the launch, run AFTER liquidity is added:
///
///   TOKEN_ADDRESS=0x… npx hardhat run scripts/deployOracle.ts --network bsc
///
/// Deploys the TWAP oracle against the live pair and points the token at it.
/// setOracle is onlyOwner, so the signer here must be the owner wallet.
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
      `setOracle is onlyOwner. Token owner is ${owner} but the signer is ` +
        `${signer.address}. Set DEPLOYER_PRIVATE_KEY to the owner's key.`
    );
  }

  const pairAddress = await pairFor(ethers, router, tokenAddress);
  if (pairAddress === ethers.ZeroAddress) {
    throw new Error("No Xenova/WBNB pair found. Was the token deployed here?");
  }

  // An oracle started on an empty pool records observations of a price that does
  // not exist yet, and those junk readings stay in the ring buffer for 25 hours.
  const pair = await ethers.getContractAt("IPancakePair", pairAddress);
  const [reserve0, reserve1] = await pair.getReserves();
  if (reserve0 === 0n || reserve1 === 0n) {
    throw new Error(
      `Pair ${pairAddress} has no liquidity yet. Add liquidity from the owner ` +
        `wallet first, then re-run this script.`
    );
  }

  console.log(`network      ${network.name}`);
  console.log(`token        ${tokenAddress}`);
  console.log(`pair         ${pairAddress}`);
  console.log(`reserves     ${reserve0} / ${reserve1}`);
  console.log("");

  const oracle = await (
    await ethers.getContractFactory("XenovaTwapOracle")
  ).deploy(pairAddress, tokenAddress);
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();

  console.log(`oracle       ${oracleAddress}`);

  const tx = await token.setOracle(oracleAddress);
  await tx.wait();
  console.log(`setOracle    ${tx.hash}`);
  console.log(`token.oracle ${await token.oracle()}`);
  console.log("");
  console.log("Verify with:");
  console.log(
    `  npx hardhat verify --network ${network.name} ${oracleAddress} ` +
      `"${pairAddress}" "${tokenAddress}"`
  );
  console.log("");
  console.log(
    "Next: start the keeper. Until it has filled 50 slots (~25h) the oracle"
  );
  console.log("reports a 0% drop and the sell tax sits at its 3% floor.");
  console.log(
    `  ORACLE_ADDRESS=${oracleAddress} npx hardhat run scripts/keeper.ts --network ${network.name}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

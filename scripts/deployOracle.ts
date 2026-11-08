import { ethers, network } from "hardhat";

import { addressesFor, pairFor } from "./addresses";

/// Step 2 of the launch, run AFTER liquidity is added:
///
///   TOKEN_ADDRESS=0x… npx hardhat run scripts/deployOracle.ts --network bsc
///
/// Deploys the TWAP oracle against the live pair and points the token at it.
/// Any funded key can deploy the oracle. setOracle is onlyOwner, so if the
/// signer is not the owner it is printed as a BscScan step for the owner to sign
/// instead — that is how mainnet is done, with the owner key never in .env.
async function main() {
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    throw new Error("Set TOKEN_ADDRESS to the deployed Xenova address.");
  }

  const { router, usdt, explorer } = addressesFor(network.name);

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY in .env.");
  }

  const token = await ethers.getContractAt("Xenova", tokenAddress);

  const owner = await token.owner();
  const isOwner = owner.toLowerCase() === signer.address.toLowerCase();

  const pairAddress = await pairFor(ethers, router, tokenAddress, usdt);
  if (pairAddress === ethers.ZeroAddress) {
    throw new Error("No Xenova/USDT pair found. Was the token deployed here?");
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

  if (isOwner) {
    const tx = await token.setOracle(oracleAddress);
    await tx.wait();
    console.log(`setOracle    ${tx.hash}`);
    console.log(`token.oracle ${await token.oracle()}`);
  } else {
    console.log("");
    console.log(`The signer ${signer.address} is not the owner, so setOracle was`);
    console.log(`not sent. Owner (${owner}): sign it on BscScan`);
    console.log('with "Connect to Web3", then Write:');
    console.log(`  ${explorer}/address/${tokenAddress}#writeContract`);
    console.log("  setOracle");
    console.log(`    oracle_  ${oracleAddress}`);
    console.log("Until it is signed the token ignores the oracle and taxes sells at 3%.");
  }
  console.log("");
  console.log("Verify with:");
  console.log(
    `  npx hardhat verify --network ${network.name} ${oracleAddress} ` +
      `"${pairAddress}" "${tokenAddress}"`
  );
  console.log("");
  console.log(
    "Next: start the keeper now — it does not wait on setOracle. Until it has"
  );
  console.log(
    "filled 50 slots (~25h) the oracle reports a 0% drop and the sell tax sits"
  );
  console.log("at its 3% floor.");
  console.log(
    `  ORACLE_ADDRESS=${oracleAddress} npx hardhat run scripts/keeper.ts --network ${network.name}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

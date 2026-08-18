import { ethers, network } from "hardhat";

import { assertTestnetOnly } from "./addresses";

/// Testnet only. Points the token at a MockPriceOracle whose drop you set by
/// hand, so the sell-tax tiers can be exercised in minutes instead of waiting
/// ~25 hours for the real TWAP oracle's ring buffer to fill.
///
///   TOKEN_ADDRESS=0x… DROP_BPS=1000 npx hardhat run scripts/mockOracle.ts --network bscTestnet
///
/// Re-run with a different DROP_BPS to walk the table. Set ORACLE_ADDRESS to
/// reuse a mock already deployed instead of deploying another one.
///
/// Useful values, from the tier table in implementation_plan.md §4:
///   0     -> 3%   (floor)
///   600   -> 5%
///   1000  -> 25%
///   1500  -> 50%   first tier the PancakeSwap UI cannot sell (slippage cap)
///   1700  -> 60%   cap
async function main() {
  // A mock oracle on mainnet is an owner-controlled tax dial with no price feed
  // behind it — exactly the centralization risk implementation_plan.md §0 warns
  // about. Never let this run there.
  assertTestnetOnly(network.name, "MockPriceOracle");

  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    throw new Error("Set TOKEN_ADDRESS to the deployed Xenova address.");
  }

  const dropBps = BigInt(process.env.DROP_BPS || "0");
  if (dropBps < 0n || dropBps > 10_000n) {
    throw new Error(`DROP_BPS must be 0..10000, got ${dropBps}.`);
  }

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY in .env.");
  }

  const token = await ethers.getContractAt("Xenova", tokenAddress);

  const owner = await token.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `setOracle is onlyOwner. Token owner is ${owner} but the signer is ` +
        `${signer.address}.`
    );
  }

  let oracleAddress = process.env.ORACLE_ADDRESS;
  if (oracleAddress && !ethers.isAddress(oracleAddress)) {
    throw new Error(`ORACLE_ADDRESS is not an address: ${oracleAddress}`);
  }

  if (!oracleAddress) {
    const deployed = await (
      await ethers.getContractFactory("MockPriceOracle")
    ).deploy();
    await deployed.waitForDeployment();
    oracleAddress = await deployed.getAddress();
    console.log(`deployed  MockPriceOracle at ${oracleAddress}`);
  } else {
    console.log(`reusing   MockPriceOracle at ${oracleAddress}`);
  }

  const oracle = await ethers.getContractAt("MockPriceOracle", oracleAddress);

  const setDropTx = await oracle.setDrop(dropBps);
  await setDropTx.wait();
  console.log(`setDrop   ${dropBps} bps  (${setDropTx.hash})`);

  if ((await token.oracle()).toLowerCase() !== oracleAddress.toLowerCase()) {
    const setOracleTx = await token.setOracle(oracleAddress);
    await setOracleTx.wait();
    console.log(`setOracle ${setOracleTx.hash}`);
  }

  // Read the effective tax back from the token, not from the mock. This is the
  // number a seller will actually pay, after the token's staleness check and
  // clamp have had their say.
  const effectiveDrop = await token.currentDropBps();
  const taxBps = await token.getSellTaxBps(effectiveDrop);

  console.log("");
  console.log(`token.oracle()      ${await token.oracle()}`);
  console.log(`currentDropBps()    ${effectiveDrop}`);
  console.log(`sell tax            ${Number(taxBps) / 100}%`);
  console.log(`buy tax             3% (fixed)`);
  console.log("");

  if (taxBps >= 5000n) {
    console.log(
      "Note: at this tier a seller needs >=50% slippage, which the PancakeSwap"
    );
    console.log(
      'UI refuses to accept. Sells through the UI should fail with "Pancake: K"'
    );
    console.log("— that is the documented limitation, not a bug.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

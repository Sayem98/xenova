import { ethers, network } from "hardhat";

/// Step 3, and it runs forever:
///
///   ORACLE_ADDRESS=0x… npx hardhat run scripts/keeper.ts --network bsc
///
/// The oracle only records a price when someone calls update(). Nothing on
/// chain does that on its own. Without this loop the ring buffer never fills,
/// get24hPriceDropBps() stays in cold start returning 0, and the sell tax is
/// pinned at its 3% floor forever — the dynamic tax simply never activates.
///
/// The call is permissionless, so this needs a funded key but not the owner's.
/// Roughly 48 calls a day, about 0.0019 BNB/day at 1 gwei.
const PERIOD_MS = 30 * 60 * 1000;

/// update() reverts with "too soon" if called inside the 30-minute window. That
/// is expected after a restart, not a failure.
const TOO_SOON = "too soon";

async function tick(oracle: any) {
  try {
    const tx = await oracle.update();
    await tx.wait();
    console.log(`${new Date().toISOString()}  updated  ${tx.hash}`);
  } catch (error: any) {
    const message = String(error?.message ?? error);
    if (message.includes(TOO_SOON)) {
      console.log(`${new Date().toISOString()}  too soon, skipping`);
      return;
    }
    // Anything else (RPC hiccup, out of gas, no funds) is worth seeing, but it
    // must not kill the loop — a missed update degrades to a stale reading,
    // which the token already treats as a 0% drop.
    console.error(`${new Date().toISOString()}  update failed: ${message}`);
  }
}

async function main() {
  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (!oracleAddress || !ethers.isAddress(oracleAddress)) {
    throw new Error("Set ORACLE_ADDRESS to the deployed XenovaTwapOracle.");
  }

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY in .env.");
  }

  const oracle = await ethers.getContractAt("XenovaTwapOracle", oracleAddress);

  console.log(`network  ${network.name}`);
  console.log(`oracle   ${oracleAddress}`);
  console.log(`keeper   ${signer.address}`);
  console.log(`balance  ${ethers.formatEther(
    await ethers.provider.getBalance(signer.address)
  )} BNB`);
  console.log(`slots    ${await oracle.count()} / ${await oracle.SLOTS()}`);
  console.log(`every    ${PERIOD_MS / 60000} minutes. Ctrl-C to stop.`);
  console.log("");

  await tick(oracle);
  setInterval(() => void tick(oracle), PERIOD_MS);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

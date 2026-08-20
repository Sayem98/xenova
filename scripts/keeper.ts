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
/// Roughly 48 recorded updates a day at 106,400 gas each — about 0.00026 BNB/day
/// at 0.05 gwei, 0.005 BNB/day at 1 gwei.
///
/// Polled far more often than the oracle's own 30-minute PERIOD, and that is
/// deliberate. get24hPriceDropBps() looks back 48 observations, not 24 hours, so
/// the two only agree while observations land 30 minutes apart. At a 30-minute
/// poll a tick arriving seconds early is refused and that observation slips a
/// full period late, permanently widening the window the tax tiers are read
/// against. Polling every 5 minutes keeps each update within 5 minutes of the
/// earliest moment it is allowed.
///
/// Polling this fast is nearly free: a refused call never becomes a transaction,
/// because ethers estimates gas first and the estimate reverts before anything
/// is broadcast. The cost is one RPC call.
const POLL_MS = 5 * 60 * 1000;

/// update() reverts with "too soon" if called inside the 30-minute window. At
/// this poll rate that is the expected outcome of five ticks in six, not a
/// failure.
const TOO_SOON = "too soon";

/// setInterval does not wait for the previous tick. A transaction still pending
/// when the next one fires would let it estimate against pre-update state, pass,
/// and broadcast a second update — which lands after the first and reverts on
/// chain, spending real gas on exactly what the estimate is there to prevent.
let inFlight = false;

async function tick(oracle: any) {
  if (inFlight) return;
  inFlight = true;

  try {
    const tx = await oracle.update();
    await tx.wait();
    console.log(`${new Date().toISOString()}  updated  ${tx.hash}`);
  } catch (error: any) {
    const message = String(error?.message ?? error);
    // Silent: logging the refused ticks would bury the ~48 real updates under
    // ~240 lines of noise a day. The quiet is what makes the log readable as a
    // heartbeat — a line every 30 minutes is healthy, a gap is worth a look.
    if (message.includes(TOO_SOON)) return;
    // Anything else (RPC hiccup, out of gas, no funds) is worth seeing, but it
    // must not kill the loop — a missed update degrades to a stale reading,
    // which the token already treats as a 0% drop.
    console.error(`${new Date().toISOString()}  update failed: ${message}`);
  } finally {
    inFlight = false;
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
  console.log(
    `polling  every ${POLL_MS / 60000} minutes; the oracle records one per 30.`
  );
  console.log(`         Only recorded updates are logged. Ctrl-C to stop.`);
  console.log("");

  await tick(oracle);
  setInterval(() => void tick(oracle), POLL_MS);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

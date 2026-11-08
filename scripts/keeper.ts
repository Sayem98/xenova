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
/// Roughly 144 recorded updates a day at up to 106,400 gas each — about
/// 0.0008 BNB/day at 0.05 gwei, 0.015 BNB/day at 1 gwei.
///
/// Timed, not polled. get24hPriceDropBps() looks back 144 observations, not 24
/// hours, so the two only agree while observations land PERIOD apart. Every
/// second an update lands late stretches that lookback for good. A fixed poll
/// interval is late by up to a full interval each time: a tick a second before
/// the mark is refused and has to wait for the next one. So instead the keeper
/// reads when the last observation was taken and sleeps until just after the
/// next one is allowed, keeping observations ~PERIOD + MARGIN_S apart.

/// Seconds past the earliest allowed moment to send the update. Covers the
/// latest block trailing real time by a block or so.
const MARGIN_S = 3;

/// update() reverts with "too soon" if called inside the period. With timed
/// wake-ups that only happens when the RPC lags behind the chain, so it is
/// retried quickly rather than logged.
const TOO_SOON = "too soon";
const TOO_SOON_RETRY_MS = 5_000;

/// How long to wait for an update to confirm. BSC confirms in seconds, so past
/// this the transaction was most likely dropped — a public RPC can accept it and
/// never pass it on. Without a limit the keeper would wait on it forever.
const CONFIRM_TIMEOUT_MS = 2 * 60_000;

/// Anything else (RPC hiccup, out of gas, no funds) is retried on this delay.
/// A missed update degrades to a stale reading, which the token already treats
/// as a 0% drop, so retrying calmly beats crashing.
const ERROR_RETRY_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/// Chain seconds until update() is allowed, plus the margin. Measured against
/// the latest block rather than this machine's clock, because block time is
/// what the oracle's "too soon" check compares against.
async function secondsUntilDue(oracle: any, period: number): Promise<number> {
  const [, lastAt] = await oracle.observations(await oracle.head());
  const latest = await ethers.provider.getBlock("latest");
  if (!latest) throw new Error("RPC returned no latest block");
  return Number(lastAt) + period + MARGIN_S - latest.timestamp;
}

/// One update after another, never two at once: each pass waits for the
/// previous transaction to confirm before working out the next wake-up.
async function run(oracle: any, signer: any, period: number): Promise<never> {
  for (;;) {
    let sent: string | undefined;
    try {
      const wait = await secondsUntilDue(oracle, period);
      // Capped at one period, so a bad reading can never park the keeper for
      // longer than a single missed update.
      if (wait > 0) await sleep(Math.min(wait, period) * 1000);

      // Sent straight after waking, without re-checking the clock: if the
      // latest block were stuck, re-checking would keep the keeper asleep.
      // A refused call never becomes a transaction — ethers estimates gas
      // first, and the estimate reverts before anything is broadcast.
      //
      // Pinned to the confirmed nonce rather than the default "pending" one.
      // After a timeout the old transaction may still be in the mempool; with
      // "pending" every retry would queue behind it, and once it confirmed the
      // whole queue would land and revert "too soon", each paying gas. With the
      // confirmed nonce a retry replaces a dropped transaction, or is refused
      // as a duplicate of one still waiting — never stacked.
      const tx = await oracle.update({ nonce: await signer.getNonce("latest") });
      sent = tx.hash;
      await tx.wait(1, CONFIRM_TIMEOUT_MS);
      // Only recorded updates are logged, so the log reads as a heartbeat: a
      // line every 10 minutes is healthy, a gap is worth a look.
      console.log(`${new Date().toISOString()}  updated  ${tx.hash}`);
    } catch (error: any) {
      const message = String(error?.message ?? error);
      if (message.includes(TOO_SOON)) {
        await sleep(TOO_SOON_RETRY_MS);
        continue;
      }
      const reason =
        error?.code === "TIMEOUT"
          ? `not confirmed after ${CONFIRM_TIMEOUT_MS / 60_000} min, resending  ${sent}`
          : message;
      console.error(`${new Date().toISOString()}  update failed: ${reason}`);
      await sleep(ERROR_RETRY_MS);
    }
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
  const period = Number(await oracle.PERIOD());
  const due = await secondsUntilDue(oracle, period);

  console.log(`network  ${network.name}`);
  console.log(`oracle   ${oracleAddress}`);
  console.log(`keeper   ${signer.address}`);
  console.log(`balance  ${ethers.formatEther(
    await ethers.provider.getBalance(signer.address)
  )} BNB`);
  console.log(`slots    ${await oracle.count()} / ${await oracle.SLOTS()}`);
  console.log(
    `timing   one update every ${period / 60} min, sent ${MARGIN_S}s after ` +
      `each is allowed; next in ${Math.max(due, 0)}s.`
  );
  console.log(`         Only recorded updates are logged. Ctrl-C to stop.`);
  console.log("");

  await run(oracle, signer, period);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

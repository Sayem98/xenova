import { ethers, network } from "hardhat";

import { addressesFor, pairFor } from "./addresses";

/// Read-only. Dumps everything worth checking about a deployed token in one
/// command, so verifying a step is not a pile of console one-liners.
///
///   TOKEN_ADDRESS=0x… npx hardhat run scripts/status.ts --network bscTestnet
///
/// Sends no transactions and needs no signer beyond an RPC connection.
/// The keeper records every 30 minutes. The slack absorbs block-time jitter and
/// a slow confirmation; past this it has missed at least one window.
const LATE_AFTER_MINUTES = 40;

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(20)} ${value}`);
}

async function main() {
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    throw new Error("Set TOKEN_ADDRESS to the deployed Xenova address.");
  }

  const { router, usdt } = addressesFor(network.name);

  // Without this, a wrong address or wrong network surfaces as an opaque
  // "could not decode result data" from the first call.
  if ((await ethers.provider.getCode(tokenAddress)) === "0x") {
    throw new Error(
      `No contract at ${tokenAddress} on ${network.name}. Check TOKEN_ADDRESS ` +
        `and that --network matches where you deployed.`
    );
  }

  const token = await ethers.getContractAt("Xenova", tokenAddress);

  console.log(`\ntoken (${network.name})`);
  line("address", tokenAddress);
  line("name / symbol", `${await token.name()} / ${await token.symbol()}`);
  line("decimals", await token.decimals());
  line("totalSupply", ethers.formatEther(await token.totalSupply()));

  const owner = await token.owner();
  console.log("\nownership");
  line("owner", owner);
  line("owner balance", ethers.formatEther(await token.balanceOf(owner)));
  line("owner fee-excluded", await token.isExcludedFromFee(owner));

  const taxReceiver = await token.taxReceiver();
  const usdtToken = await ethers.getContractAt("IERC20", usdt);
  console.log("\ntax");
  line("buy tax", "3% (fixed)");
  const drop = await token.currentDropBps();
  line("currentDropBps", `${drop}  (${Number(drop) / 100}% drop)`);
  line("sell tax now", `${Number(await token.getSellTaxBps(drop)) / 100}%`);
  line("taxReceiver", taxReceiver);
  line(
    "receiver USDT",
    ethers.formatEther(await usdtToken.balanceOf(taxReceiver))
  );

  console.log("\nswap back");
  line("swapTokensAtAmount", ethers.formatEther(await token.swapTokensAtAmount()));
  line(
    "accrued tax",
    `${ethers.formatEther(await token.balanceOf(tokenAddress))} Xenova`
  );

  // Block time, not this machine's clock — block time is what the token's
  // staleness window is measured against on chain.
  const latest = await ethers.provider.getBlock("latest");
  const chainNow = BigInt(latest?.timestamp ?? Math.floor(Date.now() / 1000));

  const oracleAddress = await token.oracle();
  console.log("\noracle");
  line("address", oracleAddress === ethers.ZeroAddress ? "(none set)" : oracleAddress);
  if (oracleAddress !== ethers.ZeroAddress) {
    // A mock has no SLOTS()/count(), so treat their absence as "not the TWAP".
    try {
      const twap = await ethers.getContractAt(
        "XenovaTwapOracle",
        oracleAddress
      );
      const count = await twap.count();
      const slots = await twap.SLOTS();
      line("type", "XenovaTwapOracle");
      // `count` is every update ever, so it runs past `slots` once the buffer
      // fills — only the cold-start phase is a meaningful fraction.
      line(
        "history",
        count < slots
          ? `${count} / ${slots} — cold start, reports 0% until ${slots}`
          : `${count} updates recorded`
      );

      // The single number that says whether the keeper is alive.
      const [, updatedAt] = await twap.observations(await twap.head());
      const ageMinutes = Number(chainNow - updatedAt) / 60;
      const staleMinutes = Number(await token.ORACLE_STALE_AFTER()) / 60;

      line("last update", `${ageMinutes.toFixed(0)} min ago`);
      line(
        "keeper",
        ageMinutes >= staleMinutes
          ? `DEAD — past the ${staleMinutes} min window, sells are at the 3% floor`
          : ageMinutes >= LATE_AFTER_MINUTES
          ? `late — missed a window, counts as dead at ${staleMinutes} min`
          : "ok — records every 30 min"
      );
    } catch {
      line("type", "not the TWAP oracle (a mock?)");
    }
  }

  const pairAddress = await pairFor(ethers, router, tokenAddress);
  console.log("\npair");
  line("address", pairAddress);
  if (pairAddress !== ethers.ZeroAddress) {
    const pair = await ethers.getContractAt("IPancakePair", pairAddress);
    const [reserve0, reserve1] = await pair.getReserves();
    const isToken0 =
      (await pair.token0()).toLowerCase() === tokenAddress.toLowerCase();
    line(
      "reserves",
      `${ethers.formatEther(isToken0 ? reserve0 : reserve1)} Xenova / ` +
        `${ethers.formatEther(isToken0 ? reserve1 : reserve0)} WBNB`
    );
    line("registered as AMM", await token.automatedMarketMakerPairs(pairAddress));
    if (reserve0 === 0n || reserve1 === 0n) {
      line("!", "no liquidity — run scripts/addLiquidity.ts");
    }
  }
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

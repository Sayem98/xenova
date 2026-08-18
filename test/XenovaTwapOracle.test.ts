import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const HALF_HOUR = 30 * 60;
const SLOTS = 50;

// Price of the token is reserve1/reserve0, so a fixed reserve0 lets reserve1
// stand in for the price directly: 1250 -> $1.25, 1000 -> $1.00, 800 -> $0.80.
const BASE = 1000n;
const price = (p: number) => BigInt(Math.round(p * 1000));

async function deployFixture() {
  const [owner] = await ethers.getSigners();

  const xenova = ethers.getAddress("0x" + "11".repeat(20));
  const wbnb = ethers.getAddress("0x" + "22".repeat(20));

  const MockPair = await ethers.getContractFactory("MockPair");
  const pair = await MockPair.deploy(xenova, wbnb);

  return { owner, pair, xenova, wbnb };
}

async function deployOracleAt(startPrice: number) {
  const { pair, xenova } = await deployFixture();
  await pair.setReserves(BASE, price(startPrice));

  const XenovaTwapOracle = await ethers.getContractFactory("XenovaTwapOracle");
  const oracle = await XenovaTwapOracle.deploy(await pair.getAddress(), xenova);

  return { pair, oracle };
}

/// Fills the ring buffer with 30-minute observations, optionally stepping the
/// price partway through. `stepAfterHours` is measured from the first
/// observation, so it reads the same way the test names do.
async function fillHistory(
  pair: any,
  oracle: any,
  step?: { afterHours: number; toPrice: number }
) {
  const start = await time.latest();
  let stepped = false;

  for (let i = 1; i < SLOTS; i++) {
    await time.increase(HALF_HOUR);

    if (step && !stepped) {
      const elapsedHours = ((await time.latest()) - start) / 3600;
      if (elapsedHours >= step.afterHours) {
        await pair.setReserves(BASE, price(step.toPrice));
        stepped = true;
      }
    }

    await oracle.update();
  }
}

describe("XenovaTwapOracle", () => {
  describe("cold start", () => {
    it("reports no drop until the buffer spans a full 24h", async () => {
      const { pair, oracle } = await deployOracleAt(1.25);

      for (let i = 1; i < SLOTS - 1; i++) {
        await time.increase(HALF_HOUR);
        await oracle.update();
      }

      expect(await oracle.count()).to.equal(SLOTS - 1);
      await pair.setReserves(BASE, price(0.5)); // a 60% crash
      const [dropBps] = await oracle.get24hPriceDropBps();
      expect(dropBps).to.equal(0);
    });
  });

  describe("keeper", () => {
    it("rejects an update inside the period", async () => {
      const { oracle } = await deployOracleAt(1.0);
      await time.increase(HALF_HOUR - 60);
      await expect(oracle.update()).to.be.revertedWith("too soon");
    });

    it("accepts an update once the period has passed", async () => {
      const { oracle } = await deployOracleAt(1.0);
      await time.increase(HALF_HOUR);
      await expect(oracle.update()).to.not.be.reverted;
      expect(await oracle.count()).to.equal(2);
    });
  });

  describe("24h drop", () => {
    // The case that separates a correct implementation from one comparing
    // against a 24-hour *average*. The drop happened early in the window, so an
    // average-based formula reports roughly -1% where the chart reports -20%.
    it("measures against the price 24h ago, not the 24h average", async () => {
      const { pair, oracle } = await deployOracleAt(1.25);
      await fillHistory(pair, oracle, { afterHours: 1.5, toPrice: 1.0 });

      const [dropBps] = await oracle.get24hPriceDropBps();
      expect(Number(dropBps)).to.be.closeTo(2000, 50);
    });

    it("reports a recent crash", async () => {
      const { pair, oracle } = await deployOracleAt(1.0);
      await fillHistory(pair, oracle, { afterHours: 23, toPrice: 0.8 });

      const [dropBps] = await oracle.get24hPriceDropBps();
      expect(Number(dropBps)).to.be.closeTo(2000, 50);
    });

    it("reports no drop when the price is flat", async () => {
      const { pair, oracle } = await deployOracleAt(1.0);
      await fillHistory(pair, oracle);

      const [dropBps] = await oracle.get24hPriceDropBps();
      expect(dropBps).to.equal(0);
    });

    it("never reports a negative drop when the price rose", async () => {
      const { pair, oracle } = await deployOracleAt(1.0);
      await fillHistory(pair, oracle, { afterHours: 2, toPrice: 1.5 });

      const [dropBps] = await oracle.get24hPriceDropBps();
      expect(dropBps).to.equal(0);
    });

    it("caps a total collapse at 100%", async () => {
      const { pair, oracle } = await deployOracleAt(1.0);
      await fillHistory(pair, oracle, { afterHours: 2, toPrice: 0.001 });

      const [dropBps] = await oracle.get24hPriceDropBps();
      expect(Number(dropBps)).to.be.lessThanOrEqual(10000);
      expect(Number(dropBps)).to.be.greaterThan(9000);
    });
  });

  describe("manipulation resistance", () => {
    // Regression test. The "now" window used to start at the newest
    // observation, which is zero-length in the same block as a keeper update:
    // the average computed as 0 and the drop came out at a full 100%, handing
    // every seller in that block the maximum tax.
    it("does not report a 100% drop in the same block as an update", async () => {
      const { pair, oracle } = await deployOracleAt(1.0);
      await fillHistory(pair, oracle);

      // get24hPriceDropBps is a view call, so it reads at the block the last
      // update landed in — exactly the degenerate case.
      const [dropBps] = await oracle.get24hPriceDropBps();
      expect(dropBps).to.equal(0);
    });

    it("barely moves on a single-block price slam", async () => {
      const { pair, oracle } = await deployOracleAt(1.0);
      await fillHistory(pair, oracle);

      const [before] = await oracle.get24hPriceDropBps();
      // A flash loan crushing the price for one block, with no time elapsed.
      await pair.setReserves(BASE, price(0.1));
      const [after] = await oracle.get24hPriceDropBps();

      expect(before).to.equal(0);
      // The slam contributes only the seconds it actually persists, so the
      // 30-minute average absorbs almost all of it.
      expect(Number(after)).to.be.lessThan(500);
    });
  });
});

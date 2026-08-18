import { expect } from "chai";
import { ethers } from "hardhat";
import { time, setBalance } from "@nomicfoundation/hardhat-network-helpers";

const BPS = 10_000n;

async function deployFixture() {
  const [owner, user, other, taxReceiver] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const wbnb = await MockERC20.deploy("Wrapped BNB", "WBNB", 0n);
  const usdt = await MockERC20.deploy(
    "Tether USD",
    "USDT",
    ethers.parseEther("1000000")
  );

  const MockFactory = await ethers.getContractFactory("MockFactory");
  const factory = await MockFactory.deploy();

  const MockRouter = await ethers.getContractFactory("MockRouter");
  const router = await MockRouter.deploy(
    await factory.getAddress(),
    await wbnb.getAddress()
  );

  const DemoToken = await ethers.getContractFactory("DemoToken");
  const token = await DemoToken.deploy(
    await router.getAddress(),
    await usdt.getAddress(),
    taxReceiver.address
  );

  const pairAddress = await factory.getPair(
    await token.getAddress(),
    await wbnb.getAddress()
  );

  // The router pays out USDT on a swap, so it needs a balance to pay from.
  await usdt.transfer(await router.getAddress(), ethers.parseEther("500000"));

  // The pair is a contract with no receive(), so fund it directly rather than
  // by transfer — it only needs a balance to pay gas as an impersonated signer.
  const pair = await ethers.getImpersonatedSigner(pairAddress);
  await setBalance(pairAddress, ethers.parseEther("1"));

  return { owner, user, other, taxReceiver, token, usdt, router, pair, pairAddress };
}

describe("DemoToken", () => {
  describe("deployment", () => {
    it("mints the full supply to the deployer", async () => {
      const { token, owner } = await deployFixture();
      const supply = ethers.parseEther("100000000");
      expect(await token.totalSupply()).to.equal(supply);
      expect(await token.balanceOf(owner.address)).to.equal(supply);
    });

    it("configures owner, receiver, pair and exclusions", async () => {
      const { token, owner, taxReceiver, pairAddress } = await deployFixture();
      expect(await token.owner()).to.equal(owner.address);
      expect(await token.taxReceiver()).to.equal(taxReceiver.address);
      expect(await token.automatedMarketMakerPairs(pairAddress)).to.equal(true);
      expect(await token.isExcludedFromFee(owner.address)).to.equal(true);
      expect(await token.isExcludedFromFee(await token.getAddress())).to.equal(
        true
      );
    });
  });

  describe("getSellTaxBps", () => {
    it("matches every row of the client's tier table", async () => {
      const { token } = await deployFixture();
      const table: Array<[number, number]> = [
        [0, 300],
        [500, 300],
        [600, 500],
        [700, 1000],
        [800, 1500],
        [900, 2000],
        [1000, 2500],
        [1100, 3000],
        [1200, 3500],
        [1300, 4000],
        [1400, 4500],
        [1500, 5000],
        [1600, 5500],
        [1700, 6000],
      ];
      for (const [drop, expected] of table) {
        expect(await token.getSellTaxBps(drop)).to.equal(expected);
      }
    });

    it("holds the 3% floor just above a 5% drop", async () => {
      const { token } = await deployFixture();
      // Without the floor the linear term starts near zero here: a 5.01% drop
      // would be taxed 0.05%, and a seller could aim for exactly that.
      expect(await token.getSellTaxBps(501)).to.equal(300);
      expect(await token.getSellTaxBps(550)).to.equal(300);
      expect(await token.getSellTaxBps(560)).to.equal(300);
      expect(await token.getSellTaxBps(570)).to.equal(350);
      expect(await token.getSellTaxBps(599)).to.equal(495);
    });

    it("caps at 60% however far the price falls", async () => {
      const { token } = await deployFixture();
      expect(await token.getSellTaxBps(1700)).to.equal(6000);
      expect(await token.getSellTaxBps(4000)).to.equal(6000);
      expect(await token.getSellTaxBps(10000)).to.equal(6000);
    });
  });

  describe("oracle safety", () => {
    async function withOracle() {
      const base = await deployFixture();
      const MockPriceOracle = await ethers.getContractFactory(
        "MockPriceOracle"
      );
      const oracle = await MockPriceOracle.deploy();
      await base.token.setOracle(await oracle.getAddress());
      return { ...base, oracle };
    }

    it("reports no drop when no oracle is set", async () => {
      const { token } = await deployFixture();
      expect(await token.currentDropBps()).to.equal(0);
    });

    it("falls back to no drop when the oracle reverts", async () => {
      const { token, oracle } = await withOracle();
      await oracle.setDrop(1700);
      await oracle.setShouldRevert(true);
      expect(await token.currentDropBps()).to.equal(0);
    });

    it("clamps an out-of-range reading", async () => {
      const { token, oracle } = await withOracle();
      await oracle.setDrop(25000);
      expect(await token.currentDropBps()).to.equal(10000);
      expect(await token.getSellTaxBps(await token.currentDropBps())).to.equal(
        6000
      );
    });

    it("falls back to no drop when the reading is stale", async () => {
      const { token, oracle } = await withOracle();
      const now = await time.latest();
      await oracle.setDropWithTimestamp(1700, now - 3 * 60 * 60);
      expect(await token.currentDropBps()).to.equal(0);
    });

    it("uses a fresh reading", async () => {
      const { token, oracle } = await withOracle();
      await oracle.setDrop(1700);
      expect(await token.currentDropBps()).to.equal(1700);
    });
  });

  describe("transfer classification", () => {
    it("does not tax wallet-to-wallet transfers", async () => {
      const { token, owner, user, other } = await deployFixture();
      const amount = ethers.parseEther("1000");
      await token.transfer(user.address, amount);
      await token.connect(user).transfer(other.address, amount);
      expect(await token.balanceOf(other.address)).to.equal(amount);
    });

    it("does not tax excluded addresses", async () => {
      const { token, owner, user, pair } = await deployFixture();
      const amount = ethers.parseEther("1000");
      await token.transfer(user.address, amount);
      await token.setExcludedFromFee(user.address, true);
      await token.connect(user).transfer(pair.address, amount);
      expect(await token.balanceOf(pair.address)).to.equal(amount);
    });

    it("takes 3% on a buy", async () => {
      const { token, user, pair, pairAddress } = await deployFixture();
      const amount = ethers.parseEther("1000");
      await token.transfer(pairAddress, amount);

      await token.connect(pair).transfer(user.address, amount);

      const fee = (amount * 300n) / BPS;
      expect(await token.balanceOf(user.address)).to.equal(amount - fee);
      expect(await token.balanceOf(await token.getAddress())).to.equal(fee);
    });

    it("takes the tier rate on a sell", async () => {
      const { token, user, pairAddress } = await deployFixture();
      const MockPriceOracle = await ethers.getContractFactory(
        "MockPriceOracle"
      );
      const oracle = await MockPriceOracle.deploy();
      await token.setOracle(await oracle.getAddress());
      await oracle.setDrop(1000); // 10% drop -> 25% tax

      const amount = ethers.parseEther("1000");
      await token.transfer(user.address, amount);
      await token.connect(user).transfer(pairAddress, amount);

      const fee = (amount * 2500n) / BPS;
      expect(await token.balanceOf(pairAddress)).to.equal(amount - fee);
      expect(await token.balanceOf(await token.getAddress())).to.equal(fee);
    });

    it("charges the 3% floor when the oracle is down", async () => {
      const { token, user, pairAddress } = await deployFixture();
      const MockPriceOracle = await ethers.getContractFactory(
        "MockPriceOracle"
      );
      const oracle = await MockPriceOracle.deploy();
      await token.setOracle(await oracle.getAddress());
      await oracle.setDrop(1700);
      await oracle.setShouldRevert(true);

      const amount = ethers.parseEther("1000");
      await token.transfer(user.address, amount);
      await token.connect(user).transfer(pairAddress, amount);

      const fee = (amount * 300n) / BPS;
      expect(await token.balanceOf(pairAddress)).to.equal(amount - fee);
    });
  });

  describe("swap back", () => {
    it("swaps accumulated tax to USDT and sends it to the receiver", async () => {
      const { token, user, pairAddress, usdt, taxReceiver } =
        await deployFixture();

      const threshold = ethers.parseEther("100");
      await token.setSwapTokensAtAmount(threshold);

      // First sell accrues tax but does not yet meet the threshold.
      await token.transfer(user.address, ethers.parseEther("10000"));
      await token.connect(user).transfer(pairAddress, ethers.parseEther("5000"));
      expect(await usdt.balanceOf(taxReceiver.address)).to.equal(0);

      const before = await usdt.balanceOf(taxReceiver.address);
      await token.connect(user).transfer(pairAddress, ethers.parseEther("5000"));
      const after = await usdt.balanceOf(taxReceiver.address);

      expect(after).to.be.greaterThan(before);
      expect(after).to.equal(threshold); // mock router swaps 1:1
    });

    it("does not swap on a buy", async () => {
      const { token, user, pair, pairAddress, usdt, taxReceiver } =
        await deployFixture();

      await token.setSwapTokensAtAmount(ethers.parseEther("1"));
      await token.transfer(pairAddress, ethers.parseEther("10000"));

      // Accrue tax into the contract via a buy, then buy again. A real pair is
      // mid-swap() during a buy and holds its reentrancy lock, so routing from
      // there would revert with "Pancake: LOCKED".
      await token.connect(pair).transfer(user.address, ethers.parseEther("1000"));
      await token.connect(pair).transfer(user.address, ethers.parseEther("1000"));

      expect(await usdt.balanceOf(taxReceiver.address)).to.equal(0);
    });

    it("keeps transfers working when the router fails", async () => {
      const { token, user, pairAddress, router, usdt, taxReceiver } =
        await deployFixture();

      await token.setSwapTokensAtAmount(ethers.parseEther("100"));
      await router.setShouldRevert(true);

      await token.transfer(user.address, ethers.parseEther("10000"));
      await token.connect(user).transfer(pairAddress, ethers.parseEther("5000"));
      await expect(
        token.connect(user).transfer(pairAddress, ethers.parseEther("5000"))
      ).to.not.be.reverted;

      expect(await usdt.balanceOf(taxReceiver.address)).to.equal(0);
    });
  });

  describe("admin", () => {
    it("rejects non-owner calls", async () => {
      const { token, user } = await deployFixture();
      await expect(token.connect(user).setOracle(user.address))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(user.address);
    });

    it("lets the owner set the tax receiver", async () => {
      const { token, other } = await deployFixture();
      await token.setTaxReceiver(other.address);
      expect(await token.taxReceiver()).to.equal(other.address);
    });

    it("rejects a zero tax receiver", async () => {
      const { token } = await deployFixture();
      await expect(
        token.setTaxReceiver(ethers.ZeroAddress)
      ).to.be.revertedWith("receiver is zero");
    });

    it("can register another AMM pair", async () => {
      const { token, other, user } = await deployFixture();
      await token.setAutomatedMarketMakerPair(other.address, true);

      const amount = ethers.parseEther("1000");
      await token.transfer(user.address, amount);
      await token.connect(user).transfer(other.address, amount);

      const fee = (amount * 300n) / BPS;
      expect(await token.balanceOf(other.address)).to.equal(amount - fee);
    });
  });
});

import { ethers, network } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  // BBACoin's constructor needs the PulseX (Uniswap V2) router for the target
  // network. It is read from the environment so the same script works across
  // testnet/mainnet without hardcoding addresses.
  const routerAddress = process.env.ROUTER_ADDRESS;
  if (!routerAddress || !ethers.isAddress(routerAddress)) {
    throw new Error(
      "ROUTER_ADDRESS is missing or invalid. Set it to the PulseX (Uniswap V2) " +
        "router address for the target network before deploying."
    );
  }

  console.log("=====================================================");
  console.log(`Deploying BBACoin to network: ${network.name}`);
  console.log("Deployer Address:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer Balance:", ethers.formatEther(balance));
  console.log("Router Address:  ", routerAddress);
  console.log("=====================================================\n");

  console.log("Deploying...");

  const BBACoin = await ethers.getContractFactory("BBACoin");
  const bba = await BBACoin.deploy(routerAddress);

  await bba.waitForDeployment();
  const contractAddress = await bba.getAddress();
  const pairAddress = await bba.dexPair();

  console.log(`✅ Success! BBACoin deployed to: ${contractAddress}`);
  console.log(`   BBA/WPLS pair created at:     ${pairAddress}`);

  console.log("\nNext steps (call as DEFAULT_ADMIN_ROLE):");
  console.log("  • setYieldVault(<vault address>)");
  console.log("  • setTreasuryWallet(<treasury address>)");
  console.log("  • grant MINTER_ROLE / BURNER_ROLE to ecosystem contracts");

  console.log(
    `\nVerify with:\n  npx hardhat verify --network ${network.name} ${contractAddress} ${routerAddress}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

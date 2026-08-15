import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "hardhat-gas-reporter";
import * as dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    pulsechainTestnet: {
      url:
        process.env.PULSE_TESTNET_V4_RPC ||
        "https://rpc.v4.testnet.pulsechain.com",
      chainId: 943,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    pulsechainMainnet: {
      url: process.env.PULSE_MAINNET_RPC || "https://rpc.pulsechain.com",
      chainId: 369,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    sepolia: {
      url:
        process.env.SEPOLIA_RPC ||
        "https://sepolia.infura.io/v3/YOUR_INFURA_KEY",
      chainId: 11155111,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    mainnet: {
      url:
        process.env.MAINNET_RPC ||
        "https://mainnet.infura.io/v3/YOUR_INFURA_KEY",
      chainId: 1,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};

export default config;

require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const SOLC_VERSION = "0.8.28";

// Use the solc-js compiler from node_modules (`solc` npm package) instead of downloading
// a native compiler. Works offline / behind strict proxies.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    const compilerPath = require.resolve("solc/soljson.js");
    return { compilerPath, isSolcJs: true, version: args.solcVersion, longVersion: require("solc/package.json").version };
  }
  return runSuper();
});

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: { optimizer: { enabled: true, runs: 1000 }, evmVersion: "cancun" },
  },
  networks: {
    // Robinhood Chain (Arbitrum Orbit L2). Testnet faucet: https://faucet.testnet.chain.robinhood.com
    // Mainnet: fill RH_MAINNET_RPC / RH_MAINNET_CHAIN_ID from https://docs.robinhood.com/chain/connecting
    robinhoodTestnet: {
      url: process.env.RH_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com/rpc",
      chainId: Number(process.env.RH_TESTNET_CHAIN_ID || 46630),
      accounts,
      explorer: "https://explorer.testnet.chain.robinhood.com",
    },
    robinhood: {
      url: process.env.RH_MAINNET_RPC || "",
      chainId: process.env.RH_MAINNET_CHAIN_ID ? Number(process.env.RH_MAINNET_CHAIN_ID) : undefined,
      accounts,
    },
  },
};

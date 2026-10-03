require('@nomicfoundation/hardhat-toolbox');
const path = require('path');
const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');

// Use the solc npm package (no compiler download needed, works offline / behind proxies).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === '0.8.28') {
    const compilerPath = require.resolve('solc/soljson.js');
    return { compilerPath, isSolcJs: true, version: '0.8.28', longVersion: '0.8.28' };
  }
  return runSuper();
});

const { PRIVATE_KEY, RPC_URL, CHAIN_ID } = process.env;

const networks = {};
// Robinhood Chain: set RPC_URL, CHAIN_ID, PRIVATE_KEY in env (see README)
if (RPC_URL) networks.robinhood = { url: RPC_URL, chainId: Number(CHAIN_ID), accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [] };

module.exports = {
  solidity: { version: '0.8.28', settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' } },
  networks,
};

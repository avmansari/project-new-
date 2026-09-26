// Hosted indexer for the PoW token, marketplace and DEX pool (Ponder).
// Reads the deployed addresses + ABIs from ../web/src/deployment.json (written by `npm run deploy:*`).
import { readFileSync } from "node:fs";
import { createConfig } from "ponder";
import type { Abi } from "viem";

const dep = JSON.parse(readFileSync(new URL("../web/src/deployment.json", import.meta.url), "utf8"));
const startBlock = Number(dep.deployBlock ?? 0);
const defaultRpc = dep.chainId === 31337 ? "http://127.0.0.1:8545" : "https://rpc.testnet.chain.robinhood.com/rpc";

export default createConfig({
  // Local: embedded PGlite (no setup). Production: set DATABASE_URL to a Postgres connection string.
  database: process.env.DATABASE_URL ? { kind: "postgres", connectionString: process.env.DATABASE_URL } : { kind: "pglite" },
  chains: {
    robinhood: {
      id: dep.chainId,
      rpc: process.env.PONDER_RPC_URL || defaultRpc,
      pollingInterval: 2_000,
      disableCache: dep.chainId === 31337, // local hardhat chains get reset
    },
  },
  contracts: {
    Token: { chain: "robinhood", abi: dep.abi as Abi, address: dep.address, startBlock },
    ...(dep.market ? { Market: { chain: "robinhood", abi: dep.market.abi as Abi, address: dep.market.address, startBlock } } : {}),
    ...(dep.pool ? { Pool: { chain: "robinhood", abi: dep.pool.abi as Abi, address: dep.pool.address, startBlock } } : {}),
  },
});

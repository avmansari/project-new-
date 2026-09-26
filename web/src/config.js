import { defineChain } from "viem";
import deployment from "./deployment.json";

// Robinhood Chain (Arbitrum Orbit L2). Double-check chainId / RPC with official docs before launch.
const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_RPC_URL || "https://rpc.testnet.chain.robinhood.com/rpc"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

const localhost = defineChain({
  id: 31337,
  name: "Hardhat Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_RPC_URL || "http://127.0.0.1:8545"] } },
});

const CHAINS = { [robinhoodTestnet.id]: robinhoodTestnet, [localhost.id]: localhost };

export const CHAIN = CHAINS[deployment.chainId] ?? robinhoodTestnet;
export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || deployment.address;
export const ABI = deployment.abi;
export const DEPLOY_BLOCK = BigInt(deployment.deployBlock ?? 0);
export const MARKET = import.meta.env.VITE_MARKET_ADDRESS ? { ...deployment.market, address: import.meta.env.VITE_MARKET_ADDRESS } : deployment.market ?? null;
export const POLL_MS = 2500;

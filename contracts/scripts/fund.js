// Local testing helper: send 10 ETH (gas money) from the local Hardhat node's first (unlocked) account to any address,
// e.g. the browser's burner wallet.   Usage (from repo root):  npm run fund -- 0xYourBurnerAddress
const { ethers } = require("ethers");

async function main() {
  const to = process.argv[2];
  if (!ethers.isAddress(to || "")) throw new Error("Usage: npm run fund -- 0xAddress");
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  const funder = await provider.getSigner(0); // hardhat node accounts are unlocked
  const tx = await funder.sendTransaction({ to, value: ethers.parseEther("10") });
  await tx.wait();
  console.log(`Sent 10 ETH to ${to}`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});

// Keep the claim fee at ~$0.10 in fixed mode: fetches ETH/USD and updates mintFeeWei on the deployed token.
// Usage (from repo root): npm run set-fee            (uses MINT_FEE_USD, default 0.1)
// Run it daily/weekly, or whenever ETH moves a lot. Only the contract owner can call it.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethUsdPrice, usdToWei } = require("./eth-price");

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "../../web/src/deployment.json"), "utf8"));
  const token = await hre.ethers.getContractAt("PowInscription", process.env.CONTRACT || dep.address);
  const usd = Number(process.env.MINT_FEE_USD || 0.1);
  const ethUsd = await ethUsdPrice();
  const wei = usdToWei(usd, ethUsd);
  const before = await token.mintFeeWei();
  if (before === wei) return console.log("Fee already up to date.");
  await (await token.setMintFeeWei(wei)).wait();
  console.log(`Claim fee: ${hre.ethers.formatEther(before)} → ${hre.ethers.formatEther(wei)} ETH ($${usd} at ETH = $${ethUsd})`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});

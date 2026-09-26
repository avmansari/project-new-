const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethUsdPrice, usdToWei } = require("./eth-price");

// target with N leading zero bits required
const targetForBits = (bits) => (2n ** 256n - 1n) >> BigInt(bits);
// env number with default ("" counts as not set)
const envNum = (name, def) => (process.env[name] === undefined || process.env[name] === "" ? def : Number(process.env[name]));

async function main() {
  const name = process.env.TOKEN_NAME || "Robin PoW";
  const symbol = process.env.TOKEN_SYMBOL || "XYZ";
  // Local chain: easy difficulty by default so you see blocks within seconds
  const isLocal = ["hardhat", "localhost"].includes(hre.network.name);
  const minBits = envNum("MIN_DIFFICULTY_BITS", isLocal ? 19 : 21);
  const initBits = envNum("INITIAL_DIFFICULTY_BITS", isLocal ? 25 : 27);

  const signers = await hre.ethers.getSigners();
  if (!signers.length) throw new Error("No deployer key. Put PRIVATE_KEY=0x... in contracts/.env");
  const [deployer] = signers;
  const { chainId } = await hre.ethers.provider.getNetwork();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Network : ${hre.network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}  balance ${hre.ethers.formatEther(balance)} ETH`);
  console.log(`Token   : ${name} (${symbol}) | min difficulty ${minBits} bits | start difficulty ${initBits} bits`);
  if (balance === 0n) {
    throw new Error(
      "Deployer has 0 ETH. Get testnet ETH from the faucet: https://faucet.testnet.chain.robinhood.com  (or https://faucet.quicknode.com/robinhood/testnet)"
    );
  }

  // Fees: $0.10 per claimed lot + 2% of marketplace volume, both to the same wallet
  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;
  const mintFeeUsd = envNum("MINT_FEE_USD", 0.1);
  let ethUsd;
  try {
    ethUsd = await ethUsdPrice();
  } catch (e) {
    if (!isLocal) throw e;
    ethUsd = 3000; // offline local testing
  }
  const mintFeeWei = usdToWei(mintFeeUsd, ethUsd);
  console.log(`Fees    : claim $${mintFeeUsd} = ${hre.ethers.formatEther(mintFeeWei)} ETH (ETH = $${ethUsd}) → ${feeRecipient}`);

  const C = await hre.ethers.getContractFactory("PowInscription");
  const c = await C.deploy(name, symbol, targetForBits(minBits), targetForBits(initBits), feeRecipient, mintFeeWei);
  await c.waitForDeployment();
  const address = await c.getAddress();
  console.log("PowInscription deployed at:", address);

  const deployBlock = (await c.deploymentTransaction().wait()).blockNumber;

  // Optional USD mode: an on-chain ETH/USD price feed (Chainlink format) keeps the claim fee at exactly $X
  if (process.env.PRICE_FEED) {
    await (await c.setUsdFee(process.env.PRICE_FEED, BigInt(Math.round(mintFeeUsd * 1e8)))).wait();
    console.log(`Claim fee follows price feed ${process.env.PRICE_FEED} ($${mintFeeUsd})`);
  }

  // Marketplace (order book: listings + bids, paid in ETH)
  const feeBps = envNum("MARKET_FEE_BPS", 200); // 200 = 2%
  const M = await hre.ethers.getContractFactory("TokenMarket");
  const lotSize = await c.BLOCK_REWARD(); // 1 lot = 1 mined block = 5,000 tokens
  const m = await M.deploy(address, lotSize, feeBps, feeRecipient);
  await m.waitForDeployment();
  const marketAddress = await m.getAddress();
  console.log(`TokenMarket deployed at:    ${marketAddress} (1 lot = ${hre.ethers.formatEther(lotSize)} tokens, fee ${feeBps / 100}% → ${feeRecipient})`);

  const explorer = hre.network.config.explorer;
  if (explorer) {
    console.log("Explorer (token): ", `${explorer}/address/${address}`);
    console.log("Explorer (market):", `${explorer}/address/${marketAddress}`);
  }

  // Share addresses + ABIs with the web app and CLI miner
  const artifact = await hre.artifacts.readArtifact("PowInscription");
  const marketArtifact = await hre.artifacts.readArtifact("TokenMarket");
  const out = {
    address,
    chainId: Number(chainId),
    network: hre.network.name,
    deployBlock,
    abi: artifact.abi,
    market: { address: marketAddress, abi: marketArtifact.abi },
  };
  for (const dir of ["../web/src", "../miner-cli"]) {
    const file = path.join(__dirname, "..", dir, "deployment.json");
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log("wrote", path.relative(process.cwd(), file));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

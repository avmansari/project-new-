const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// target with N leading zero bits required
const targetForBits = (bits) => (2n ** 256n - 1n) >> BigInt(bits);

async function main() {
  const name = process.env.TOKEN_NAME || "Robin PoW";
  const symbol = process.env.TOKEN_SYMBOL || "XYZ";
  // Local chain: easy difficulty by default so you see blocks within seconds
  const isLocal = ["hardhat", "localhost"].includes(hre.network.name);
  const minBits = Number(process.env.MIN_DIFFICULTY_BITS || (isLocal ? 8 : 16));
  const initBits = Number(process.env.INITIAL_DIFFICULTY_BITS || (isLocal ? 16 : 22));

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
      "Deployer has 0 ETH. Testnet ETH lo faucet se: https://faucet.testnet.chain.robinhood.com  (ya https://faucet.quicknode.com/robinhood/testnet)"
    );
  }

  const C = await hre.ethers.getContractFactory("PowInscription");
  const c = await C.deploy(name, symbol, targetForBits(minBits), targetForBits(initBits));
  await c.waitForDeployment();
  const address = await c.getAddress();
  console.log("PowInscription deployed at:", address);

  const deployBlock = (await c.deploymentTransaction().wait()).blockNumber;
  const explorer = hre.network.config.explorer;
  if (explorer) console.log("Explorer:", `${explorer}/address/${address}`);

  // Share address + ABI with the web app and CLI miner
  const artifact = await hre.artifacts.readArtifact("PowInscription");
  const out = { address, chainId: Number(chainId), network: hre.network.name, deployBlock, abi: artifact.abi };
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

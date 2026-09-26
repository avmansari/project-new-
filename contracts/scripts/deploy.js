const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// target with N leading zero bits required
const targetForBits = (bits) => (2n ** 256n - 1n) >> BigInt(bits);

async function main() {
  const name = process.env.TOKEN_NAME || "Robin PoW";
  const symbol = process.env.TOKEN_SYMBOL || "XYZ";
  const minBits = Number(process.env.MIN_DIFFICULTY_BITS || 16);
  const initBits = Number(process.env.INITIAL_DIFFICULTY_BITS || 22);

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying ${name} (${symbol}) from ${deployer.address} on ${hre.network.name}`);

  const C = await hre.ethers.getContractFactory("PowInscription");
  const c = await C.deploy(name, symbol, targetForBits(minBits), targetForBits(initBits));
  await c.waitForDeployment();
  const address = await c.getAddress();
  console.log("PowInscription deployed at:", address);

  // Share address + ABI with the web app and CLI miner
  const { chainId } = await hre.ethers.provider.getNetwork();
  const artifact = await hre.artifacts.readArtifact("PowInscription");
  const out = { address, chainId: Number(chainId), network: hre.network.name, abi: artifact.abi };
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

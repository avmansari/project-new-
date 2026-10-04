// Usage:
//   npx hardhat run scripts/deploy.cjs                      (in-process test chain)
//   npx hardhat run scripts/deploy.cjs --network localhost  (after `npx hardhat node`)
//   npx hardhat run scripts/deploy.cjs --network robinhood  (testnet/mainnet, needs env vars)
// Env: CLAIM_FEE_ETH (native coin amount equal to ~$0.1, e.g. 0.00004), TOKEN_NAME, TOKEN_SYMBOL,
//      OWNER (optional, defaults to deployer), OPEN_CLAIM=true|false (default true)
const fs = require('fs');
const { ethers, network } = require('hardhat');

async function main() {
  const merkle = JSON.parse(fs.readFileSync('data/merkle.json', 'utf8'));
  const [deployer] = await ethers.getSigners();
  const owner = process.env.OWNER || deployer.address;
  const fee = ethers.parseEther(process.env.CLAIM_FEE_ETH || '0.00004');
  const name = process.env.TOKEN_NAME || 'Chomp';
  const symbol = process.env.TOKEN_SYMBOL || 'CHOMP';
  const poolRaw = 100_000_000_000n * 10n ** 18n * 75n / 100n;

  console.log(`network ${network.name}, deployer ${deployer.address}, owner ${owner}`);
  const token = await (await ethers.getContractFactory('ClaimToken')).deploy(name, symbol, owner);
  await token.waitForDeployment();
  const claim = await (await ethers.getContractFactory('MerkleClaim')).deploy(await token.getAddress(), merkle.root, fee, owner);
  await claim.waitForDeployment();
  console.log('token', await token.getAddress());
  console.log('claim', await claim.getAddress());

  // Only possible in one go when deployer == owner (otherwise do these 3 steps from the owner wallet).
  if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    await (await token.setTransferAllowed(await claim.getAddress(), true)).wait();
    await (await token.transfer(await claim.getAddress(), poolRaw)).wait();
    if (process.env.OPEN_CLAIM !== 'false') await (await claim.setClaimOpen(true)).wait();
    console.log('claim contract whitelisted + funded with 75% pool; claimOpen =', process.env.OPEN_CLAIM !== 'false');
  } else {
    console.log('MANUAL (owner wallet): token.setTransferAllowed(claim,true); token.transfer(claim, 75% pool); claim.setClaimOpen(true)');
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const cfg = {
    chainId, chainIdHex: '0x' + chainId.toString(16),
    chainName: process.env.CHAIN_NAME || 'Robinhood Chain',
    rpcUrl: process.env.PUBLIC_RPC_URL || process.env.RPC_URL || 'http://127.0.0.1:8545',
    explorer: process.env.EXPLORER_URL || '',
    claimAddress: await claim.getAddress(), tokenAddress: await token.getAddress(),
    symbol, nativeSymbol: process.env.NATIVE_SYMBOL || 'ETH',
    walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID || '',
    gallery: [],
  };
  fs.writeFileSync('web/config.js', 'window.CHOMP_CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n');
  fs.copyFileSync('data/merkle.json', 'web/merkle.json');
  console.log('wrote web/config.js and web/merkle.json');
}
main().catch((e) => { console.error(e); process.exit(1); });

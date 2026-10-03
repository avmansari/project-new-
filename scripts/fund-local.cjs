// Local testing only: gives test ETH to any address on `npm run node`.
// Usage: ADDRESS=0x... npx hardhat run scripts/fund-local.cjs --network localhost
const { ethers, network } = require('hardhat');
(async () => {
  if (network.name !== 'localhost' && network.name !== 'hardhat') throw new Error('Local networks only');
  const a = ethers.getAddress(process.env.ADDRESS || '');
  await network.provider.send('hardhat_setBalance', [a, '0x' + (100n * 10n ** 18n).toString(16)]);
  console.log(`funded ${a} with 100 test ETH on ${network.name}`);
})().catch((e) => { console.error(e.message); process.exit(1); });

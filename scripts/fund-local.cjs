// Local testing only: gives 100 test ETH to every wallet in data/wallets.csv on the local node.
// Usage (works on Windows/Mac/Linux):  npm run fund:local
// Optional extra address:  PowerShell: $env:ADDRESS="0x..."; npm run fund:local   |  cmd: set ADDRESS=0x...&& npm run fund:local
const fs = require('fs');
const { ethers, network } = require('hardhat');

(async () => {
  if (network.name !== 'localhost' && network.name !== 'hardhat') throw new Error('Local networks only');
  const list = fs.readFileSync('data/wallets.csv', 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',')[0].trim());
  if (process.env.ADDRESS) list.push(process.env.ADDRESS.trim());
  for (const w of [...new Set(list.map((x) => ethers.getAddress(x)))]) {
    await network.provider.send('hardhat_setBalance', [w, '0x' + (100n * 10n ** 18n).toString(16)]);
    console.log(`funded ${w} with 100 test ETH`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

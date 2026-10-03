// Usage: node scripts/build-merkle.mjs   (reads data/wallets.csv: wallet,amount in whole tokens)
// Leaf format matches contracts/MerkleClaim.sol (OpenZeppelin double-hash).
import { readFileSync, writeFileSync } from 'node:fs';
import { keccak256, AbiCoder, getAddress, parseUnits } from 'ethers';

const TOTAL = parseUnits('100000000000', 18);
const rows = readFileSync('data/wallets.csv', 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split(',')).map(([w, a], index) => ({ index, wallet: getAddress(w.trim()), amount: parseUnits(a.trim(), 18) }));
if (rows.reduce((s, r) => s + r.amount, 0n) > TOTAL) throw new Error('Allocations exceed total supply');

const abi = AbiCoder.defaultAbiCoder();
const leaf = (r) => keccak256(keccak256(abi.encode(['uint256', 'address', 'uint256'], [r.index, r.wallet, r.amount])));
const pair = (a, b) => (a < b ? keccak256(a + b.slice(2)) : keccak256(b + a.slice(2))); // sorted pairs
let level = rows.map(leaf); const layers = [level];
while (level.length > 1) {
  const next = [];
  for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
  layers.push(next); level = next;
}
const proof = (idx) => { const p = []; for (const l of layers.slice(0, -1)) { const s = idx ^ 1; if (s < l.length) p.push(l[s]); idx >>= 1; } return p; };

const claims = Object.fromEntries(rows.map((r) => [r.wallet, { index: r.index, amount: r.amount.toString(), proof: proof(r.index) }]));
writeFileSync('data/merkle.json', JSON.stringify({ root: level[0], claims }, null, 2));
console.log('root', level[0], 'wallets', rows.length);

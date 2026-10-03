// Usage: node scripts/build-merkle.mjs [input.csv]   (default data/wallets.csv: wallet,amount in whole tokens)
// Output: data/merkle.json  { root, total, claims: { <wallet>: { index, amount, proof } } }
import { readFileSync, writeFileSync } from 'node:fs';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { getAddress, parseUnits } from 'ethers';

const input = process.argv[2] || 'data/wallets.csv';
const TOTAL_SUPPLY = parseUnits('100000000000', 18);
const CLAIM_POOL = TOTAL_SUPPLY * 75n / 100n; // 75% community airdrop

const rows = readFileSync(input, 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean).map((l, i) => {
  const [w, a] = l.split(',');
  return { index: i, wallet: getAddress(w.trim()), amount: parseUnits(a.trim(), 18) };
});

const seen = new Set();
for (const r of rows) { if (seen.has(r.wallet)) throw new Error(`Duplicate wallet ${r.wallet}`); seen.add(r.wallet); }
const total = rows.reduce((s, r) => s + r.amount, 0n);
if (total > CLAIM_POOL) throw new Error(`Allocations (${total}) exceed the 75% claim pool (${CLAIM_POOL})`);

const tree = StandardMerkleTree.of(rows.map((r) => [r.index, r.wallet, r.amount]), ['uint256', 'address', 'uint256']);
const claims = Object.fromEntries(rows.map((r) => [r.wallet, { index: r.index, amount: r.amount.toString(), proof: tree.getProof(r.index) }]));
writeFileSync('data/merkle.json', JSON.stringify({ root: tree.root, total: total.toString(), claims }, null, 2));
console.log(`root ${tree.root}\nwallets ${rows.length}\ntotal ${total} (raw units)`);

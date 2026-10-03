// Usage: node scripts/build-merkle.mjs
// Amounts in the CSV are whole tokens; converted to raw units (6 decimals).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const DECIMALS = 6n;
const TOTAL_SUPPLY = 100_000_000_000n;
const sha = (b) => createHash('sha256').update(b).digest();

const rows = readFileSync('data/wallets.csv', 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split(',')).map(([wallet, amt]) => ({ wallet: wallet.trim(), amount: BigInt(amt) * 10n ** DECIMALS }));

const total = rows.reduce((s, r) => s + r.amount, 0n);
if (total > TOTAL_SUPPLY * 10n ** DECIMALS) throw new Error('Allocations exceed total supply');

const leaf = (i, r) => sha(Buffer.concat([Buffer.from([0]), Buffer.from(`${i}:${r.wallet}:${r.amount}`)]));
let level = rows.map((r, i) => leaf(i, r));
const layers = [level];
while (level.length > 1) {
  const next = [];
  for (let i = 0; i < level.length; i += 2) {
    const [a, b] = [level[i], level[i + 1] ?? level[i]].sort(Buffer.compare);
    next.push(sha(Buffer.concat([Buffer.from([1]), a, b])));
  }
  layers.push(next); level = next;
}
const proof = (idx) => layers.slice(0, -1).map((l) => { const s = l[idx ^ 1] ?? l[idx]; idx >>= 1; return s.toString('hex'); });

const claims = Object.fromEntries(rows.map((r, i) => [r.wallet, { index: i, amount: r.amount.toString(), proof: proof(i) }]));
writeFileSync('data/merkle.json', JSON.stringify({ root: level[0].toString('hex'), total: total.toString(), claims }, null, 2));
console.log('root', level[0].toString('hex'), 'wallets', rows.length);

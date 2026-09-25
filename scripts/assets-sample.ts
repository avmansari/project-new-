import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sampleArt } from "../src/assets/sample.js";

/**
 * Test ke liye nakli images banao (asli images ke bina bhi flow dekh sako).
 * usage: npm run assets:sample -- <folder> <count>
 */
const [folder, countArg] = process.argv.slice(2);
const count = Number(countArg ?? 6);
if (!folder || !Number.isInteger(count) || count < 1 || count > 200) {
  console.error("Usage: npm run assets:sample -- <folder> <count 1..200>");
  process.exit(1);
}
mkdirSync(resolve(folder), { recursive: true });
for (let i = 1; i <= count; i++) writeFileSync(join(resolve(folder), `${i}.png`), sampleArt(i));
writeFileSync(join(resolve(folder), "cover.png"), sampleArt(99));
console.log(`${count} sample images + cover.png banayi: ${resolve(folder)}`);

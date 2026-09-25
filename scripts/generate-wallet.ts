import { accountXpubFromMnemonic, deriveReceiveAddress, newMnemonic } from "../src/zcash/address.js";

/**
 * Naya wallet banata hai. Mnemonic sirf screen pe ek baar dikhega, kahin save nahi hota.
 * MAINNET ke liye ye script offline / trusted machine pe chalao.
 */
const mnemonic = newMnemonic();
const xpub = accountXpubFromMnemonic(mnemonic, 0);

console.log("\n=== NAYA WALLET ===\n");
console.log("MNEMONIC (24 words) -- kagaz pe likho, screenshot/cloud mein MAT rakho:\n");
console.log(mnemonic, "\n");
console.log("WALLET_XPUB (ye .env mein daalna, ye safe hai):\n");
console.log(xpub, "\n");
console.log("Pehle 3 testnet addresses:");
for (let i = 0; i < 3; i++) console.log(`  [${i}] ${deriveReceiveAddress(xpub, i, "testnet")}`);
console.log("Pehle 3 mainnet addresses:");
for (let i = 0; i < 3; i++) console.log(`  [${i}] ${deriveReceiveAddress(xpub, i, "mainnet")}`);
console.log("\nMnemonic kho gaya to funds wapas nahi aayenge.\n");

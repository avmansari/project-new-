import { hashPassword } from "../src/services/admin-auth.js";
import { promptHidden } from "../src/util/prompt.js";

/** Admin dashboard ka password set/badalne ke liye. Password kabhi disk pe nahi jaata, sirf hash. */
const pw = await promptHidden("Admin password: ");
const pw2 = await promptHidden("Dobara likho: ");
if (pw !== pw2) {
  console.error("Password match nahi hua.");
  process.exit(1);
}
if (pw.length < 8) {
  console.error("Password kam se kam 8 characters ka hona chahiye.");
  process.exit(1);
}
console.log("\n.env mein ye line daalo:\n");
console.log(`ADMIN_PASSWORD_HASH=${hashPassword(pw)}`);
console.log("\n(App ko restart karna hoga taaki naya password chale.)");

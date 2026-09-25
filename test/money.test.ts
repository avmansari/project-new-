import { test } from "node:test";
import assert from "node:assert/strict";
import { formatZec, parseZec } from "../src/money.js";

test("parseZec exact", () => {
  assert.equal(parseZec("1"), 100_000_000n);
  assert.equal(parseZec("0.01"), 1_000_000n);
  assert.equal(parseZec("0.00000001"), 1n);
  assert.equal(parseZec("12.5"), 1_250_000_000n);
});
test("parseZec galat input reject", () => {
  for (const bad of ["", "-1", "1.123456789", "abc", "0", "0.0", "1e5", " "]) {
    assert.throws(() => parseZec(bad), Error, bad);
  }
});
test("formatZec round trip", () => {
  for (const s of ["1", "0.01", "12.5", "0.00000001", "100.12345678"]) {
    assert.equal(formatZec(parseZec(s)), s);
  }
});

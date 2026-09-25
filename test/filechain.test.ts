import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileChain } from "../src/chain/file.js";
import { createChain } from "../src/chain/index.js";
import { parseZec } from "../src/money.js";

test("FileChain: pay=0 conf, mine se confirmations badhte hain", async () => {
  const c = new FileChain(join(mkdtempSync(join(tmpdir(), "fc-")), "chain.json"));
  c.pay("tmX", parseZec("1"));
  assert.equal((await c.getReceived("tmX"))[0].confirmations, 0);
  c.mine(1);
  assert.equal((await c.getReceived("tmX"))[0].confirmations, 1);
  c.mine(9);
  assert.equal((await c.getReceived("tmX"))[0].confirmations, 10);
  assert.equal((await c.getReceived("tmOther")).length, 0);
});

test("nakli chain mainnet pe block hai", () => {
  assert.throws(() => createChain({ network: "mainnet", chainBackend: "file", fakeChainFile: "x" }), /mainnet/);
});

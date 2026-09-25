import { test } from "node:test";
import assert from "node:assert/strict";

const TM = "tmJ3XjCvYhzm4cQsNH9SpZqHoMEKKS3DUXT";

function mockLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}
function mockWindow(provider: any) {
  const w: any = Object.assign(new EventTarget(), { localStorage: mockLocalStorage() });
  if (provider) w.noirwallet = { isNoirWallet: true, zcash: provider };
  return w;
}
function mockProvider(handlers: Record<string, (params?: unknown[]) => unknown>) {
  return {
    async request(a: { method: string; params?: unknown[] }) {
      const h = handlers[a.method];
      if (!h) throw Object.assign(new Error("not found"), { code: -32601 });
      return h(a.params);
    },
  };
}

async function loadModule(win: any) {
  (globalThis as any).window = win;
  (globalThis as any).localStorage = win.localStorage;
  const mod = await import(`../web/wallet-state.js?t=${Math.random()}`);
  return mod;
}

test("getConnectedAddress/disconnectWallet: localStorage se read/write", async () => {
  const win = mockWindow(null);
  const m = await loadModule(win);
  assert.equal(m.getConnectedAddress(), null);
  win.localStorage.setItem("wallet:address", TM);
  assert.equal(m.getConnectedAddress(), TM);
  m.disconnectWallet();
  assert.equal(m.getConnectedAddress(), null);
});

test("onWalletChange: connect/disconnect pe listener fire hota hai; unsubscribe kaam karta hai", async () => {
  const provider = mockProvider({ zcash_requestAccounts: () => ({ transparent: TM }) });
  const win = mockWindow(provider);
  const m = await loadModule(win);
  const seen: (string | null)[] = [];
  const unsub = m.onWalletChange((a: string | null) => seen.push(a));
  await m.connectWallet("testnet");
  assert.deepEqual(seen, [TM]);
  m.disconnectWallet();
  assert.deepEqual(seen, [TM, null]);
  unsub();
  await m.connectWallet("testnet");
  assert.deepEqual(seen, [TM, null]); // unsubscribe ke baad aur events nahi aate
});

test("connectWallet: galat network wallet reject hota hai, state nahi badalti", async () => {
  const mainnetAddr = "t1R9NRtic3D9GH7YcA79FvT4oUSbrNfqLFL";
  const provider = mockProvider({ zcash_requestAccounts: () => ({ transparent: mainnetAddr }) });
  const win = mockWindow(provider);
  const m = await loadModule(win);
  await assert.rejects(m.connectWallet("testnet"), /testnet/);
  assert.equal(m.getConnectedAddress(), null);
});

test("connectWallet: provider na mile to saaf error", async () => {
  const win = mockWindow(null);
  const m = await loadModule(win);
  await assert.rejects(m.connectWallet("testnet"), /Noir Wallet nahi mila/);
});

test("tryReconnect: silent, galat network pe chup rehta hai (error nahi, bas null)", async () => {
  const mainnetAddr = "t1R9NRtic3D9GH7YcA79FvT4oUSbrNfqLFL";
  const provider = mockProvider({ zcash_getAccounts: () => ({ transparent: mainnetAddr }) });
  const win = mockWindow(provider);
  const m = await loadModule(win);
  const r = await m.tryReconnect("testnet");
  assert.equal(r, null);
  assert.equal(m.getConnectedAddress(), null);
});

test("short(): address ko chhota dikhata hai", async () => {
  const win = mockWindow(null);
  const m = await loadModule(win);
  assert.equal(m.short(TM), "tmJ3Xj...DUXT");
  assert.equal(m.short(null), "");
});

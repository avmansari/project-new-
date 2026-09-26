// Regression tests for the security review findings (docs/AUDIT.md).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const MAX = 2n ** 256n - 1n;
const E = ethers.parseEther;
const LOT = E("5000");

function mine(challenge, miner, target) {
  for (let nonce = 0n; ; nonce++) {
    const d = BigInt(ethers.solidityPackedKeccak256(["bytes32", "address", "uint256"], [challenge, miner, nonce]));
    if (d <= target) return nonce;
  }
}

async function claim(token, who, value = 0n) {
  const ch = await token.challenge();
  return token.connect(who).mint(mine(ch, who.address, await token.currentTarget()), ch, { value });
}

describe("Security review regressions", () => {
  async function setup(fee = E("0.00003")) {
    const [owner, alice, bob] = await ethers.getSigners();
    const bad = await (await ethers.getContractFactory("RejectingWallet")).deploy();
    const Token = await ethers.getContractFactory("PowInscription");
    const token = await Token.deploy("Robin PoW", "XYZ", MAX >> 4n, MAX >> 4n, owner.address, fee);
    const market = await (await ethers.getContractFactory("TokenMarket")).deploy(await token.getAddress(), LOT, 200, owner.address);
    const pool = await (await ethers.getContractFactory("TokenPool")).deploy(await token.getAddress(), LOT, 200, owner.address);
    return { owner, alice, bob, bad, token, market, pool };
  }

  it("H-1: a fee wallet that rejects ETH can't block mining; fee is kept and withdrawable", async () => {
    const { owner, alice, bad, token } = await setup();
    await token.connect(owner).setFeeRecipient(await bad.getAddress());
    await expect(claim(token, alice, E("0.00003"))).to.emit(token, "FeeDeferred");
    expect(await token.feesOwed()).to.equal(E("0.00003"));
    expect(await token.balanceOf(alice.address)).to.equal(LOT);
    // fix the wallet, then anyone can flush the fees to it
    await token.connect(owner).setFeeRecipient(owner.address);
    await expect(token.connect(alice).withdrawFees()).to.changeEtherBalance(owner, E("0.00003"));
    expect(await token.feesOwed()).to.equal(0n);
  });

  it("H-1: same protection on the marketplace and the pool", async () => {
    const { owner, alice, bob, bad, token, market, pool } = await setup(0n);
    for (let i = 0; i < 4; i++) await claim(token, alice);
    await market.connect(owner).setFee(200, await bad.getAddress());
    await token.connect(alice).approve(await market.getAddress(), LOT);
    await market.connect(alice).list(1, E("1"), 0);
    await expect(market.connect(bob).buy(0, 1, { value: E("1") })).to.emit(market, "FeeDeferred");
    expect(await market.feesOwed()).to.equal(E("0.02"));

    await pool.connect(owner).setFee(200, await bad.getAddress());
    await token.connect(alice).approve(await pool.getAddress(), LOT * 2n);
    await pool.connect(alice).addLiquidity(LOT * 2n, 0, (await time.latest()) + 600, { value: E("1") });
    const [total] = await pool.quoteBuy(1);
    await expect(pool.connect(bob).buyLots(1, (await time.latest()) + 600, { value: total })).to.emit(pool, "FeeDeferred");
    expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal((await pool.reserveEth()) + (await pool.feesOwed()));
  });

  it("M-1: a broken USD price feed can never charge more than the 0.01 ETH cap", async () => {
    const { owner, token } = await setup();
    const feed = await (await ethers.getContractFactory("MockPriceFeed")).deploy();
    await feed.set(1, await time.latest()); // ETH "worth" $0.00000001
    await token.connect(owner).setUsdFee(await feed.getAddress(), 10_000_000n);
    expect(await token.mintFee()).to.equal(E("0.01"));
  });

  it("M-1: feed decimals are read from the feed (18-decimal feed gives the same fee)", async () => {
    const { owner, token } = await setup();
    const feed = await (await ethers.getContractFactory("MockPriceFeed")).deploy();
    await feed.setDecimals(18);
    await feed.set(4000n * 10n ** 18n, await time.latest());
    await token.connect(owner).setUsdFee(await feed.getAddress(), 10_000_000n); // $0.10
    expect(await token.mintFee()).to.equal(E("0.000025"));
  });

  it("M-2: raising the market fee does not apply to listings created before; lowering does", async () => {
    const { owner, alice, bob, token, market } = await setup(0n);
    for (let i = 0; i < 2; i++) await claim(token, alice);
    await token.connect(alice).approve(await market.getAddress(), LOT * 2n);
    await market.connect(alice).list(2, E("1"), 0); // listed at 2%
    await market.connect(owner).setFee(500, owner.address); // owner raises to 5%
    await expect(market.connect(bob).buy(0, 1, { value: E("1") })).to.changeEtherBalance(alice, E("0.98")); // still 2%
    await market.connect(owner).setFee(100, owner.address); // lowered to 1%
    await expect(market.connect(bob).buy(0, 1, { value: E("1") })).to.changeEtherBalance(alice, E("0.99"));
  });

  it("only the fee recipient can ever receive withdrawn fees", async () => {
    const { alice, token } = await setup();
    await expect(token.connect(alice).withdrawFees()).to.changeEtherBalance(alice, 0n);
  });
});

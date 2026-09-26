const { expect } = require("chai");
const { ethers } = require("hardhat");

const MAX = 2n ** 256n - 1n;
const E = ethers.parseEther;

function mine(challenge, miner, target) {
  for (let nonce = 0n; ; nonce++) {
    const d = BigInt(ethers.solidityPackedKeccak256(["bytes32", "address", "uint256"], [challenge, miner, nonce]));
    if (d <= target) return nonce;
  }
}

describe("TokenMarket", () => {
  async function setup(feeBps = 100) {
    const [owner, alice, bob, feeWallet] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("PowInscription");
    const token = await Token.deploy("Robin PoW", "XYZ", MAX >> 4n, MAX >> 4n);
    const Market = await ethers.getContractFactory("TokenMarket");
    const market = await Market.deploy(await token.getAddress(), feeBps, feeWallet.address);
    // alice mines 2 blocks = 10,000 tokens
    for (let i = 0; i < 2; i++) {
      const ch = await token.challenge();
      await token.connect(alice).mint(mine(ch, alice.address, await token.currentTarget()), ch);
    }
    return { token, market, owner, alice, bob, feeWallet, m: await market.getAddress() };
  }

  it("list -> partial buy -> buy rest; seller gets ETH minus fee, buyer gets tokens", async () => {
    const { token, market, alice, bob, feeWallet, m } = await setup();
    await token.connect(alice).approve(m, E("1000"));
    await market.connect(alice).list(E("1000"), E("0.001")); // 0.001 ETH per token

    const cost = await market.quoteBuy(0, E("400"));
    expect(cost).to.equal(E("0.4"));
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const feeBefore = await ethers.provider.getBalance(feeWallet.address);
    await expect(market.connect(bob).buy(0, E("400"), { value: cost })).to.emit(market, "Trade");
    expect(await token.balanceOf(bob.address)).to.equal(E("400"));
    expect((await ethers.provider.getBalance(alice.address)) - aliceBefore).to.equal(E("0.396")); // 1% fee
    expect((await ethers.provider.getBalance(feeWallet.address)) - feeBefore).to.equal(E("0.004"));

    await market.connect(bob).buy(0, E("600"), { value: E("1") }); // overpay -> refund
    expect(await token.balanceOf(bob.address)).to.equal(E("1000"));
    expect((await market.orders(0)).active).to.equal(false);
    expect(await ethers.provider.getBalance(m)).to.equal(0n);
  });

  it("rejects underpayment and buying more than listed", async () => {
    const { token, market, alice, bob, m } = await setup();
    await token.connect(alice).approve(m, E("100"));
    await market.connect(alice).list(E("100"), E("0.01"));
    await expect(market.connect(bob).buy(0, E("10"), { value: E("0.05") })).to.be.revertedWithCustomError(market, "InsufficientPayment");
    await expect(market.connect(bob).buy(0, E("101"), { value: E("2") })).to.be.revertedWithCustomError(market, "BadParams");
  });

  it("cancel listing returns unsold tokens; only maker can cancel", async () => {
    const { token, market, alice, bob, m } = await setup();
    await token.connect(alice).approve(m, E("500"));
    await market.connect(alice).list(E("500"), E("0.01"));
    await expect(market.connect(bob).cancel(0)).to.be.revertedWithCustomError(market, "NotMaker");
    await market.connect(alice).cancel(0);
    expect(await token.balanceOf(alice.address)).to.equal(E("10000"));
    await expect(market.connect(bob).buy(0, 1, { value: E("1") })).to.be.revertedWithCustomError(market, "OrderClosed");
  });

  it("bid -> holder sells into it (partial fills) -> escrow fully paid out, never over", async () => {
    const { token, market, alice, bob, m } = await setup(0);
    // bob bids for 3 tokens at an awkward price so rounding matters
    const price = 333333333333333333n; // ~0.333 ETH per token
    await market.connect(bob).bid(E("3"), price, { value: E("1") });
    const escrow = await market.bidEscrow(0);
    await token.connect(alice).approve(m, E("3"));
    await market.connect(alice).sell(0, E("1"));
    await market.connect(alice).sell(0, E("1"));
    await market.connect(alice).sell(0, E("1"));
    expect(await token.balanceOf(bob.address)).to.equal(E("3"));
    expect(await market.bidEscrow(0)).to.equal(0n);
    expect(await ethers.provider.getBalance(m)).to.equal(0n);
    expect(escrow).to.equal((E("3") * price + E("1") - 1n) / E("1"));
  });

  it("cancel bid refunds remaining escrow", async () => {
    const { token, market, alice, bob, m } = await setup(0);
    await market.connect(bob).bid(E("10"), E("0.01"), { value: E("0.1") });
    await token.connect(alice).approve(m, E("4"));
    await market.connect(alice).sell(0, E("4"));
    await market.connect(bob).cancel(0);
    expect(await ethers.provider.getBalance(m)).to.equal(0n);
    expect(await market.bidEscrow(0)).to.equal(0n);
  });

  it("wrong side and fee limits", async () => {
    const { token, market, alice, bob, owner, m } = await setup();
    await token.connect(alice).approve(m, E("10"));
    await market.connect(alice).list(E("10"), E("0.01"));
    await expect(market.connect(bob).sell(0, E("1"))).to.be.revertedWithCustomError(market, "WrongSide");
    await expect(market.connect(owner).setFee(501, owner.address)).to.be.revertedWithCustomError(market, "BadParams");
    await expect(market.connect(bob).setFee(10, bob.address)).to.be.revertedWithCustomError(market, "NotOwner");
    const orders = await market.getOrders(0, 10);
    expect(orders.length).to.equal(1);
  });
});

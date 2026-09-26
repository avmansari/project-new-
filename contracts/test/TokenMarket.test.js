const { expect } = require("chai");
const { ethers } = require("hardhat");

const MAX = 2n ** 256n - 1n;
const E = ethers.parseEther;
const LOT = E("5000");

function mine(challenge, miner, target) {
  for (let nonce = 0n; ; nonce++) {
    const d = BigInt(ethers.solidityPackedKeccak256(["bytes32", "address", "uint256"], [challenge, miner, nonce]));
    if (d <= target) return nonce;
  }
}

describe("TokenMarket (lots of 5,000)", () => {
  async function setup(feeBps = 100, blocks = 4) {
    const [owner, alice, bob, feeWallet] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("PowInscription");
    const token = await Token.deploy("Robin PoW", "XYZ", MAX >> 4n, MAX >> 4n);
    const Market = await ethers.getContractFactory("TokenMarket");
    const market = await Market.deploy(await token.getAddress(), LOT, feeBps, feeWallet.address);
    for (let i = 0; i < blocks; i++) {
      const ch = await token.challenge();
      await token.connect(alice).mint(mine(ch, alice.address, await token.currentTarget()), ch);
    }
    return { token, market, owner, alice, bob, feeWallet, m: await market.getAddress() };
  }

  it("list 3 lots -> buy 1 lot -> buy 2 lots; exact ETH, fee to fee wallet", async () => {
    const { token, market, alice, bob, feeWallet, m } = await setup();
    await token.connect(alice).approve(m, LOT * 3n);
    await market.connect(alice).list(3, E("0.5")); // 0.5 ETH per lot
    expect(await token.balanceOf(m)).to.equal(LOT * 3n);

    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const feeBefore = await ethers.provider.getBalance(feeWallet.address);
    await expect(market.connect(bob).buy(0, 1, { value: E("0.5") })).to.emit(market, "Trade");
    expect(await token.balanceOf(bob.address)).to.equal(LOT);
    expect((await ethers.provider.getBalance(alice.address)) - aliceBefore).to.equal(E("0.495"));
    expect((await ethers.provider.getBalance(feeWallet.address)) - feeBefore).to.equal(E("0.005"));

    await market.connect(bob).buy(0, 2, { value: E("2") }); // overpay -> refund
    expect(await token.balanceOf(bob.address)).to.equal(LOT * 3n);
    expect((await market.orders(0)).active).to.equal(false);
    expect(await ethers.provider.getBalance(m)).to.equal(0n);
  });

  it("only whole lots: 0 lots / more than listed / underpay rejected", async () => {
    const { token, market, alice, bob, m } = await setup();
    await token.connect(alice).approve(m, LOT * 2n);
    await market.connect(alice).list(2, E("1"));
    await expect(market.connect(bob).buy(0, 0, { value: E("1") })).to.be.revertedWithCustomError(market, "BadParams");
    await expect(market.connect(bob).buy(0, 3, { value: E("3") })).to.be.revertedWithCustomError(market, "BadParams");
    await expect(market.connect(bob).buy(0, 1, { value: E("0.9") })).to.be.revertedWithCustomError(market, "InsufficientPayment");
    await expect(market.connect(alice).list(0, E("1"))).to.be.revertedWithCustomError(market, "BadParams");
  });

  it("cannot list more lots than you hold", async () => {
    const { token, market, alice, m } = await setup(100, 1); // alice has exactly 1 lot
    await token.connect(alice).approve(m, LOT * 2n);
    await expect(market.connect(alice).list(2, E("1"))).to.be.revertedWithCustomError(token, "InsufficientBalance");
  });

  it("cancel listing returns unsold lots; only maker can cancel", async () => {
    const { token, market, alice, bob, m } = await setup();
    await token.connect(alice).approve(m, LOT * 2n);
    await market.connect(alice).list(2, E("1"));
    await expect(market.connect(bob).cancel(0)).to.be.revertedWithCustomError(market, "NotMaker");
    await market.connect(alice).cancel(0);
    expect(await token.balanceOf(alice.address)).to.equal(LOT * 4n);
    await expect(market.connect(bob).buy(0, 1, { value: E("1") })).to.be.revertedWithCustomError(market, "OrderClosed");
  });

  it("bid 3 lots -> holder sells 1 + 2 lots -> escrow fully paid out", async () => {
    const { token, market, alice, bob, m } = await setup(0);
    await market.connect(bob).bid(3, E("0.3"), { value: E("1") }); // refund 0.1
    expect(await ethers.provider.getBalance(m)).to.equal(E("0.9"));
    await token.connect(alice).approve(m, LOT * 3n);
    await market.connect(alice).sell(0, 1);
    await market.connect(alice).sell(0, 2);
    expect(await token.balanceOf(bob.address)).to.equal(LOT * 3n);
    expect(await ethers.provider.getBalance(m)).to.equal(0n);
  });

  it("cancel bid refunds remaining ETH", async () => {
    const { token, market, alice, bob, m } = await setup(0);
    await market.connect(bob).bid(4, E("0.25"), { value: E("1") });
    await token.connect(alice).approve(m, LOT);
    await market.connect(alice).sell(0, 1);
    await market.connect(bob).cancel(0);
    expect(await ethers.provider.getBalance(m)).to.equal(0n);
  });

  it("wrong side and fee limits", async () => {
    const { token, market, alice, bob, owner, m } = await setup();
    await token.connect(alice).approve(m, LOT);
    await market.connect(alice).list(1, E("1"));
    await expect(market.connect(bob).sell(0, 1)).to.be.revertedWithCustomError(market, "WrongSide");
    await expect(market.connect(owner).setFee(501, owner.address)).to.be.revertedWithCustomError(market, "BadParams");
    await expect(market.connect(bob).setFee(10, bob.address)).to.be.revertedWithCustomError(market, "NotOwner");
    expect(await market.lotSize()).to.equal(LOT);
  });
});

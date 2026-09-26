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

describe("TokenPool (DEX, whole lots)", () => {
  async function setup(protocolFeeBps = 200) {
    const [owner, alice, bob, feeWallet] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("PowInscription");
    const token = await Token.deploy("Robin PoW", "XYZ", MAX >> 4n, MAX >> 4n, feeWallet.address, 0n);
    const Pool = await ethers.getContractFactory("TokenPool");
    const pool = await Pool.deploy(await token.getAddress(), LOT, protocolFeeBps, feeWallet.address);
    for (const who of [alice, alice, alice, alice, alice, alice, bob, bob]) {
      const ch = await token.challenge();
      await token.connect(who).mint(mine(ch, who.address, await token.currentTarget()), ch);
    }
    const p = await pool.getAddress();
    const deadline = async () => (await time.latest()) + 600;
    return { token, pool, owner, alice, bob, feeWallet, p, deadline };
  }

  async function seed(ctx) {
    // alice opens the pool: 4 lots (20,000 tokens) + 2 ETH  => 0.5 ETH / lot
    await ctx.token.connect(ctx.alice).approve(ctx.p, LOT * 4n);
    await ctx.pool.connect(ctx.alice).addLiquidity(LOT * 4n, 0, await ctx.deadline(), { value: E("2") });
  }

  it("first provider sets the price; LP minted; 1000 wei locked", async () => {
    const ctx = await setup();
    await seed(ctx);
    expect(await ctx.pool.reserveEth()).to.equal(E("2"));
    expect(await ctx.pool.reserveToken()).to.equal(LOT * 4n);
    expect(await ctx.pool.priceOfLot()).to.equal(E("0.5"));
    expect(await ctx.pool.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(1000n);
  });

  it("buyLots: exact lots out, protocol fee (2%) in ETH to fee wallet, refund extra, k grows", async () => {
    const ctx = await setup();
    await seed(ctx);
    const k0 = (await ctx.pool.reserveEth()) * (await ctx.pool.reserveToken());
    const [total, fee] = await ctx.pool.quoteBuy(1);
    const tx = ctx.pool.connect(ctx.bob).buyLots(1, await ctx.deadline(), { value: total + E("1") });
    await expect(tx).to.changeEtherBalances([ctx.bob, ctx.feeWallet], [-total, fee]);
    expect(await ctx.token.balanceOf(ctx.bob.address)).to.equal(LOT * 3n); // mined 2 + bought 1
    expect(fee).to.equal(((total - fee) * 200n) / 10_000n);
    const k1 = (await ctx.pool.reserveEth()) * (await ctx.pool.reserveToken());
    expect(k1).to.be.gt(k0); // LP fee stays in the pool
    expect(await ethers.provider.getBalance(ctx.p)).to.equal(await ctx.pool.reserveEth());
  });

  it("sellLots: exact lots in, ETH out after fees, slippage guard", async () => {
    const ctx = await setup();
    await seed(ctx);
    const [net, fee] = await ctx.pool.quoteSell(1);
    await ctx.token.connect(ctx.bob).approve(ctx.p, LOT);
    await expect(ctx.pool.connect(ctx.bob).sellLots(1, net + 1n, await ctx.deadline())).to.be.revertedWithCustomError(ctx.pool, "Slippage");
    const tx = ctx.pool.connect(ctx.bob).sellLots(1, net, await ctx.deadline());
    await expect(tx).to.changeEtherBalances([ctx.bob, ctx.feeWallet], [net, fee]);
    expect(await ethers.provider.getBalance(ctx.p)).to.equal(await ctx.pool.reserveEth());
  });

  it("underpaying a buy or buying the whole pool reverts; expired deadline reverts", async () => {
    const ctx = await setup();
    await seed(ctx);
    const [total] = await ctx.pool.quoteBuy(1);
    await expect(ctx.pool.connect(ctx.bob).buyLots(1, await ctx.deadline(), { value: total - 1n })).to.be.revertedWithCustomError(ctx.pool, "Slippage");
    await expect(ctx.pool.quoteBuy(4)).to.be.revertedWithCustomError(ctx.pool, "InsufficientLiquidity");
    await expect(ctx.pool.connect(ctx.bob).buyLots(1, (await time.latest()) - 1, { value: total })).to.be.revertedWithCustomError(ctx.pool, "Expired");
  });

  it("second provider adds at the current ratio; remove returns a fair share", async () => {
    const ctx = await setup();
    await seed(ctx);
    await ctx.token.connect(ctx.bob).approve(ctx.p, LOT * 2n);
    await ctx.pool.connect(ctx.bob).addLiquidity(LOT * 2n, 0, await ctx.deadline(), { value: E("0.5") }); // needs 1 lot
    expect(await ctx.token.balanceOf(ctx.bob.address)).to.be.closeTo(LOT, 1n);
    const lp = await ctx.pool.balanceOf(ctx.bob.address);
    const [ethOut] = await ctx.pool.connect(ctx.bob).removeLiquidity.staticCall(lp, 0, 0, await ctx.deadline());
    expect(ethOut).to.be.closeTo(E("0.5"), 2n); // at most rounding dust stays in the pool
    await ctx.pool.connect(ctx.bob).removeLiquidity(lp, 0, 0, await ctx.deadline());
    expect(await ctx.pool.balanceOf(ctx.bob.address)).to.equal(0n);
    expect(await ethers.provider.getBalance(ctx.p)).to.equal(await ctx.pool.reserveEth());
  });

  it("owner-only fee changes, capped at 5%", async () => {
    const ctx = await setup();
    await expect(ctx.pool.connect(ctx.bob).setFee(100, ctx.bob.address)).to.be.revertedWithCustomError(ctx.pool, "NotOwner");
    await expect(ctx.pool.connect(ctx.owner).setFee(501, ctx.owner.address)).to.be.revertedWithCustomError(ctx.pool, "BadParams");
    await ctx.pool.connect(ctx.owner).setFee(50, ctx.owner.address);
    expect(await ctx.pool.protocolFeeBps()).to.equal(50n);
  });
});

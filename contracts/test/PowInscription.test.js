const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const MAX = 2n ** 256n - 1n;
const targetForBits = (bits) => MAX >> BigInt(bits);
const REWARD = ethers.parseEther("5000");

// Tiny CPU miner used by the tests (same algorithm the real miners use)
function mine(challenge, miner, target) {
  for (let nonce = 0n; ; nonce++) {
    const digest = BigInt(ethers.solidityPackedKeccak256(["bytes32", "address", "uint256"], [challenge, miner, nonce]));
    if (digest <= target) return { nonce, digest };
  }
}

async function mineAndClaim(c, signer) {
  const ch = await c.challenge();
  const { nonce } = mine(ch, signer.address, await c.currentTarget());
  return c.connect(signer).mint(nonce, ch);
}

describe("PowInscription", () => {
  // fee = 0 for the mining tests; fee behaviour has its own tests below
  async function deploy(minBits = 4, initBits = 6, fee = 0n) {
    const [alice, bob, feeWallet] = await ethers.getSigners();
    const C = await ethers.getContractFactory("PowInscription");
    const c = await C.deploy("Robin PoW", "XYZ", targetForBits(minBits), targetForBits(initBits), feeWallet.address, fee);
    return { c, alice, bob, feeWallet };
  }

  it("claim mints exactly 5000 tokens directly into the claiming wallet", async () => {
    const { c, alice } = await deploy();
    const challenge = await c.challenge();
    await expect(mineAndClaim(c, alice)).to.emit(c, "BlockMined").and.to.emit(c, "Inscribed");
    expect(await c.balanceOf(alice.address)).to.equal(REWARD);
    expect(await c.height()).to.equal(1n);
    expect(await c.challenge()).to.not.equal(challenge);
    expect(await c.blocksMinedBy(alice.address)).to.equal(1n);
  });

  it("only the first solver of a challenge wins; the second gets StaleChallenge", async () => {
    const { c, alice, bob } = await deploy();
    const challenge = await c.challenge();
    const target = await c.currentTarget();
    const a = mine(challenge, alice.address, target);
    const b = mine(challenge, bob.address, target);
    await c.connect(alice).mint(a.nonce, challenge);
    await expect(c.connect(bob).mint(b.nonce, challenge)).to.be.revertedWithCustomError(c, "StaleChallenge");
  });

  it("solutions are bound to the wallet (cannot be copied by someone else)", async () => {
    const { c, alice, bob } = await deploy(4, 12);
    const challenge = await c.challenge();
    const a = mine(challenge, alice.address, await c.currentTarget());
    await expect(c.connect(bob).mint(a.nonce, challenge)).to.be.revertedWithCustomError(c, "InsufficientWork");
  });

  it("same wallet can mine many blocks", async () => {
    const { c, alice } = await deploy();
    for (let i = 0; i < 5; i++) await mineAndClaim(c, alice);
    expect(await c.blocksMinedBy(alice.address)).to.equal(5n);
    expect(await c.balanceOf(alice.address)).to.equal(REWARD * 5n);
  });

  it("emits an inscription JSON", async () => {
    const { c, alice } = await deploy();
    await expect(mineAndClaim(c, alice))
      .to.emit(c, "Inscribed")
      .withArgs(0n, alice.address, 'data:,{"p":"prc-20","op":"mint","tick":"XYZ","blk":"0","amt":"5000"}');
  });

  it("gets harder every fast block (25% per instant block)", async () => {
    const { c, alice } = await deploy(4, 6);
    const t0 = await c.miningTarget();
    await mineAndClaim(c, alice);
    const t1 = await c.miningTarget();
    expect(t1).to.be.lt(t0);
        expect(t1).to.be.lte((t0 / 480n) * 361n); // T=120: (3T+1)/4T
  });

  it("stays the same when blocks come exactly on time and eases when slow", async () => {
    const { c, alice } = await deploy(4, 8);
    await mineAndClaim(c, alice);
    let before = await c.miningTarget();
    await time.increase(119); // + 1s for the tx block = 120s = T
    await mineAndClaim(c, alice);
    expect(await c.miningTarget()).to.equal((before / 480n) * 480n);

    before = await c.miningTarget();
    await time.increase(599); // 5T
    await mineAndClaim(c, alice);
    expect(await c.miningTarget()).to.equal((before / 480n) * 960n); // 2x easier
  });

  it("eases difficulty after a long stall", async () => {
    const { c } = await deploy(4, 10);
    const t0 = await c.currentTarget();
    await time.increase(120 * 10 * 2 + 1);
    expect(await c.currentTarget()).to.equal(t0 << 2n);
  });

  it("rejects stale challenge early", async () => {
    const { c, alice } = await deploy();
    await expect(c.connect(alice).mint(0, ethers.ZeroHash)).to.be.revertedWithCustomError(c, "StaleChallenge");
  });

  it("previewReward and getMiningInfo report 5000 per block", async () => {
    const { c, alice } = await deploy(4, 6);
    const info = await c.getMiningInfo();
    expect(info._requiredBits).to.equal(6n);
    expect(info._reward).to.equal(REWARD);
    const ch = await c.challenge();
    const { nonce } = mine(ch, alice.address, await c.currentTarget());
    const [reward, , valid] = await c.previewReward(alice.address, nonce);
    expect(valid).to.equal(true);
    expect(reward).to.equal(REWARD);
  });

  it("supply cap: 21M / 5000 = 4200 blocks", async () => {
    const { c } = await deploy();
    expect((await c.MAX_SUPPLY()) / (await c.BLOCK_REWARD())).to.equal(4200n);
  });

  describe("claim fee ($0.10 per lot)", () => {
    const FEE = ethers.parseEther("0.00003"); // ~$0.10 at ETH = $3,333

    it("claim must pay the fee; fee goes to the fee wallet; extra is refunded", async () => {
      const { c, alice, feeWallet } = await deploy(4, 6, FEE);
      const ch = await c.challenge();
      const { nonce } = mine(ch, alice.address, await c.currentTarget());
      await expect(c.connect(alice).mint(nonce, ch)).to.be.revertedWithCustomError(c, "InsufficientFee");
      await expect(c.connect(alice).mint(nonce, ch, { value: FEE - 1n })).to.be.revertedWithCustomError(c, "InsufficientFee");

      const before = await ethers.provider.getBalance(feeWallet.address);
      const tx = c.connect(alice).mint(nonce, ch, { value: FEE * 10n });
      await expect(tx).to.changeEtherBalances([alice, feeWallet], [-FEE, FEE]); // 9x FEE refunded
      await expect(tx).to.emit(c, "BlockMined");
      expect((await ethers.provider.getBalance(feeWallet.address)) - before).to.equal(FEE);
      expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(0n);
      expect(await c.balanceOf(alice.address)).to.equal(REWARD);
    });

    it("a losing (stale) claim pays nothing", async () => {
      const { c, alice, bob } = await deploy(4, 6, FEE);
      const ch = await c.challenge();
      const t = await c.currentTarget();
      const a = mine(ch, alice.address, t);
      const b = mine(ch, bob.address, t);
      await c.connect(alice).mint(a.nonce, ch, { value: FEE });
      const bobBefore = await ethers.provider.getBalance(bob.address);
      await expect(c.connect(bob).mint(b.nonce, ch, { value: FEE })).to.be.revertedWithCustomError(c, "StaleChallenge");
      // only gas was spent, the fee itself was not taken
      expect(bobBefore - (await ethers.provider.getBalance(bob.address))).to.be.lt(FEE);
    });

    it("owner can update the fixed fee and recipient; capped; others cannot", async () => {
      const { c, alice, bob } = await deploy(4, 6, FEE);
      await c.connect(alice).setMintFeeWei(FEE * 2n); // alice = deployer = owner
      expect(await c.mintFee()).to.equal(FEE * 2n);
      await expect(c.connect(alice).setMintFeeWei(ethers.parseEther("0.02"))).to.be.revertedWithCustomError(c, "FeeTooHigh");
      await expect(c.connect(bob).setMintFeeWei(1)).to.be.revertedWithCustomError(c, "NotOwner");
      await c.connect(alice).setFeeRecipient(bob.address);
      expect(await c.feeRecipient()).to.equal(bob.address);
    });

    it("USD mode: $0.10 converted with the price feed; stale feed falls back to the fixed fee", async () => {
      const { c, alice } = await deploy(4, 6, FEE);
      const Feed = await ethers.getContractFactory("MockPriceFeed");
      const feed = await Feed.deploy();
      const now = BigInt(await time.latest());
      await feed.set(4000n * 10n ** 8n, now); // ETH = $4,000
      await c.connect(alice).setUsdFee(await feed.getAddress(), 10_000_000n); // $0.10
      expect(await c.mintFee()).to.equal(ethers.parseEther("0.000025")); // 0.1 / 4000

      await feed.set(4000n * 10n ** 8n, now - 2n * 86400n); // 2 days old
      expect(await c.mintFee()).to.equal(FEE);
      await expect(c.connect(alice).setUsdFee(await feed.getAddress(), 2n * 10n ** 8n)).to.be.revertedWithCustomError(c, "FeeTooHigh");
    });
  });
});

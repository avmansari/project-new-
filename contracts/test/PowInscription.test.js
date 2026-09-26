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
  async function deploy(minBits = 4, initBits = 6) {
    const [alice, bob] = await ethers.getSigners();
    const C = await ethers.getContractFactory("PowInscription");
    const c = await C.deploy("Robin PoW", "XYZ", targetForBits(minBits), targetForBits(initBits));
    return { c, alice, bob };
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
    // elapsed is ~1s on hardhat: factor (180+1)/240
    expect(t1).to.be.lte((t0 / 240n) * 181n);
  });

  it("stays the same when blocks come exactly on time and eases when slow", async () => {
    const { c, alice } = await deploy(4, 8);
    await mineAndClaim(c, alice);
    let before = await c.miningTarget();
    await time.increase(59); // + 1s for the tx block = 60s
    await mineAndClaim(c, alice);
    expect(await c.miningTarget()).to.equal((before / 240n) * 240n);

    before = await c.miningTarget();
    await time.increase(299);
    await mineAndClaim(c, alice);
    expect(await c.miningTarget()).to.equal((before / 240n) * 480n); // 2x easier
  });

  it("eases difficulty after a long stall", async () => {
    const { c } = await deploy(4, 10);
    const t0 = await c.currentTarget();
    await time.increase(60 * 10 * 2 + 1);
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
});

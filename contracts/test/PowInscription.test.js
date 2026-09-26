const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const MAX = 2n ** 256n - 1n;
const targetForBits = (bits) => MAX >> BigInt(bits);

// Tiny CPU miner used by the tests (same algorithm the real miners use)
function mine(challenge, miner, target, { minExtraBits = 0 } = {}) {
  const need = target >> BigInt(minExtraBits);
  for (let nonce = 0n; ; nonce++) {
    const digest = BigInt(ethers.solidityPackedKeccak256(["bytes32", "address", "uint256"], [challenge, miner, nonce]));
    if (digest <= need) return { nonce, digest };
  }
}

describe("PowInscription", () => {
  async function deploy(minBits = 4, initBits = 6) {
    const [alice, bob, burner] = await ethers.getSigners();
    const C = await ethers.getContractFactory("PowInscription");
    const c = await C.deploy("Robin PoW", "XYZ", targetForBits(minBits), targetForBits(initBits));
    return { c, alice, bob, burner };
  }

  it("mints the block reward for a valid solution and rotates the challenge", async () => {
    const { c, alice } = await deploy();
    const challenge = await c.challenge();
    const target = await c.currentTarget();
    const { nonce } = mine(challenge, alice.address, target);

    await expect(c.connect(alice).mint(nonce, challenge, alice.address))
      .to.emit(c, "BlockMined")
      .and.to.emit(c, "Inscribed");

    expect(await c.height()).to.equal(1n);
    expect(await c.balanceOf(alice.address)).to.be.gte(ethers.parseEther("50"));
    expect(await c.challenge()).to.not.equal(challenge);
    expect(await c.blocksMinedBy(alice.address)).to.equal(1n);
  });

  it("only the first solver of a challenge wins; the second gets StaleChallenge", async () => {
    const { c, alice, bob } = await deploy();
    const challenge = await c.challenge();
    const target = await c.currentTarget();
    const a = mine(challenge, alice.address, target);
    const b = mine(challenge, bob.address, target);

    await c.connect(alice).mint(a.nonce, challenge, alice.address);
    await expect(c.connect(bob).mint(b.nonce, challenge, bob.address)).to.be.revertedWithCustomError(c, "StaleChallenge");
  });

  it("solutions are bound to msg.sender (cannot be front-run/stolen)", async () => {
    const { c, alice, bob } = await deploy(4, 12);
    const challenge = await c.challenge();
    const target = await c.currentTarget();
    const a = mine(challenge, alice.address, target);
    // Bob copies Alice's nonce from the mempool -> digest differs for him
    await expect(c.connect(bob).mint(a.nonce, challenge, bob.address)).to.be.revertedWithCustomError(c, "InsufficientWork");
  });

  it("same user can mine many blocks", async () => {
    const { c, alice } = await deploy();
    for (let i = 0; i < 5; i++) {
      const ch = await c.challenge();
      const { nonce } = mine(ch, alice.address, await c.currentTarget());
      await c.connect(alice).mint(nonce, ch, alice.address);
    }
    expect(await c.blocksMinedBy(alice.address)).to.equal(5n);
  });

  it("gives a luck bonus for extra zero bits (up to 2x)", async () => {
    const { c, alice } = await deploy(4, 4);
    const ch = await c.challenge();
    const { nonce } = mine(ch, alice.address, await c.currentTarget(), { minExtraBits: 8 });
    const [preview, , valid] = await c.previewReward(alice.address, nonce);
    expect(valid).to.equal(true);
    expect(preview).to.equal(ethers.parseEther("100"));
    await c.connect(alice).mint(nonce, ch, alice.address);
    expect(await c.balanceOf(alice.address)).to.equal(ethers.parseEther("100"));
  });

  it("burner wallet can mine while tokens go to the main wallet", async () => {
    const { c, alice, burner } = await deploy();
    const ch = await c.challenge();
    const { nonce } = mine(ch, burner.address, await c.currentTarget());
    await c.connect(burner).mint(nonce, ch, alice.address);
    expect(await c.balanceOf(alice.address)).to.be.gt(0n);
    expect(await c.balanceOf(burner.address)).to.equal(0n);
  });

  it("emits an inscription JSON", async () => {
    const { c, alice } = await deploy(4, 4);
    const ch = await c.challenge();
    const { nonce } = mine(ch, alice.address, await c.currentTarget());
    const [reward] = await c.previewReward(alice.address, nonce);
    const amt = ethers.formatEther(reward).replace(/\.0$/, "");
    await expect(c.connect(alice).mint(nonce, ch, alice.address))
      .to.emit(c, "Inscribed")
      .withArgs(0n, alice.address, `data:,{"p":"prc-20","op":"mint","tick":"XYZ","blk":"0","amt":"${amt}"}`);
  });

  it("raises difficulty when blocks come too fast", async () => {
    const { c, alice } = await deploy(4, 6);
    const before = await c.miningTarget();
    for (let i = 0; i < 32; i++) {
      const ch = await c.challenge();
      const { nonce } = mine(ch, alice.address, await c.currentTarget());
      await c.connect(alice).mint(nonce, ch, alice.address);
    }
    expect(await c.miningTarget()).to.be.lt(before); // lower target = harder
  });

  it("eases difficulty after a long stall", async () => {
    const { c } = await deploy(4, 10);
    const t0 = await c.currentTarget();
    await time.increase(60 * 10 * 2 + 1);
    expect(await c.currentTarget()).to.equal(t0 << 2n);
  });

  it("rejects stale challenge early", async () => {
    const { c, alice } = await deploy();
    await expect(c.connect(alice).mint(0, ethers.ZeroHash, alice.address)).to.be.revertedWithCustomError(c, "StaleChallenge");
  });

  it("getMiningInfo returns consistent data", async () => {
    const { c } = await deploy(4, 6);
    const info = await c.getMiningInfo();
    expect(info._requiredBits).to.equal(6n);
    expect(info._difficulty).to.equal(targetForBits(4) / targetForBits(6));
    expect(info._baseReward).to.equal(ethers.parseEther("50"));
  });
});

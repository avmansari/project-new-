const { expect } = require('chai');
const { ethers } = require('hardhat');
const { StandardMerkleTree } = require('@openzeppelin/merkle-tree');

const E18 = 10n ** 18n;
const FEE = ethers.parseEther('0.00004'); // ~ $0.1, example value

async function setup() {
  const [owner, a, b, c, stranger] = await ethers.getSigners();
  const rows = [[0, a.address, 1000n * E18], [1, b.address, 2500n * E18], [2, c.address, 500n * E18]];
  const tree = StandardMerkleTree.of(rows, ['uint256', 'address', 'uint256']);
  const token = await (await ethers.getContractFactory('ClaimToken')).deploy('Chomp', 'CHOMP', owner.address);
  const claim = await (await ethers.getContractFactory('MerkleClaim')).deploy(await token.getAddress(), tree.root, FEE, owner.address);
  await token.setTransferAllowed(await claim.getAddress(), true);
  await token.transfer(await claim.getAddress(), 75_000_000_000n * E18);
  await claim.setClaimOpen(true);
  return { owner, a, b, c, stranger, rows, tree, token, claim };
}

describe('ClaimToken', () => {
  it('has 100B fixed supply minted to owner', async () => {
    const { token, owner } = await setup();
    expect(await token.totalSupply()).to.equal(100_000_000_000n * E18);
    expect(await token.balanceOf(owner.address)).to.equal(25_000_000_000n * E18);
  });
  it('blocks wallet-to-wallet transfers until trading is enabled', async () => {
    const { token, claim, a, b, tree } = await setup();
    await claim.connect(a).claim(0, a.address, 1000n * E18, tree.getProof(0), { value: FEE });
    await expect(token.connect(a).transfer(b.address, 1n)).to.be.revertedWith('Trading not enabled');
    await token.enableTrading();
    await token.connect(a).transfer(b.address, 1n);
    expect(await token.balanceOf(b.address)).to.equal(1n);
  });
  it('only owner can enable trading / whitelist', async () => {
    const { token, stranger } = await setup();
    await expect(token.connect(stranger).enableTrading()).to.be.reverted;
    await expect(token.connect(stranger).setTransferAllowed(stranger.address, true)).to.be.reverted;
  });
});

describe('MerkleClaim', () => {
  it('pays tokens to the proof wallet and collects the fee', async () => {
    const { claim, token, a, tree } = await setup();
    await expect(claim.connect(a).claim(0, a.address, 1000n * E18, tree.getProof(0), { value: FEE }))
      .to.emit(claim, 'Claimed').withArgs(0, a.address, 1000n * E18, FEE);
    expect(await token.balanceOf(a.address)).to.equal(1000n * E18);
    expect(await ethers.provider.getBalance(await claim.getAddress())).to.equal(FEE);
  });
  it('lets a third party pay gas but tokens go to the right wallet', async () => {
    const { claim, token, a, stranger, tree } = await setup();
    await claim.connect(stranger).claim(0, a.address, 1000n * E18, tree.getProof(0), { value: FEE });
    expect(await token.balanceOf(a.address)).to.equal(1000n * E18);
    expect(await token.balanceOf(stranger.address)).to.equal(0n);
  });
  it('rejects wrong fee (too low / too high)', async () => {
    const { claim, a, tree } = await setup();
    await expect(claim.connect(a).claim(0, a.address, 1000n * E18, tree.getProof(0), { value: 0 })).to.be.revertedWith('Wrong fee');
    await expect(claim.connect(a).claim(0, a.address, 1000n * E18, tree.getProof(0), { value: FEE + 1n })).to.be.revertedWith('Wrong fee');
  });
  it('rejects double claim', async () => {
    const { claim, a, tree } = await setup();
    await claim.connect(a).claim(0, a.address, 1000n * E18, tree.getProof(0), { value: FEE });
    await expect(claim.connect(a).claim(0, a.address, 1000n * E18, tree.getProof(0), { value: FEE })).to.be.revertedWith('Already claimed');
  });
  it('rejects bad proof, wrong amount, wrong account', async () => {
    const { claim, a, b, tree } = await setup();
    await expect(claim.claim(0, a.address, 9999n * E18, tree.getProof(0), { value: FEE })).to.be.revertedWith('Invalid proof');
    await expect(claim.claim(0, b.address, 1000n * E18, tree.getProof(0), { value: FEE })).to.be.revertedWith('Invalid proof');
    await expect(claim.claim(0, a.address, 1000n * E18, tree.getProof(1), { value: FEE })).to.be.revertedWith('Invalid proof');
  });
  it('is closed until owner opens it', async () => {
    const { claim, a, tree } = await setup();
    await claim.setClaimOpen(false);
    await expect(claim.connect(a).claim(0, a.address, 1000n * E18, tree.getProof(0), { value: FEE })).to.be.revertedWith('Claim not open');
  });
  it('owner can change fee, withdraw fees, recover tokens; others cannot', async () => {
    const { claim, token, owner, a, b, stranger, tree } = await setup();
    await claim.connect(a).claim(0, a.address, 1000n * E18, tree.getProof(0), { value: FEE });
    await expect(claim.connect(stranger).withdrawFees(stranger.address)).to.be.reverted;
    await expect(claim.connect(stranger).setClaimFee(0)).to.be.reverted;
    await expect(claim.connect(stranger).recoverTokens(stranger.address, 1n)).to.be.reverted;
    await expect(claim.withdrawFees(owner.address)).to.changeEtherBalances([claim, owner], [-FEE, FEE]);
    await claim.setClaimFee(FEE * 2n);
    await expect(claim.connect(b).claim(1, b.address, 2500n * E18, tree.getProof(1), { value: FEE })).to.be.revertedWith('Wrong fee');
    await claim.connect(b).claim(1, b.address, 2500n * E18, tree.getProof(1), { value: FEE * 2n });
    await claim.recoverTokens(owner.address, 1000n * E18);
    expect(await token.balanceOf(owner.address)).to.equal(25_000_000_000n * E18 + 1000n * E18);
  });
});

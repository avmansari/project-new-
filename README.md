# ⛏️ PoW Inscription Miner: Robinhood Chain

Bitcoin-style Proof-of-Work mining for an inscription token on Robinhood Chain (EVM L2).
Users mine with their **CPU, GPU (WebGPU) or phone browser**. The **first** miner to solve the current block
mints the reward, and the reward depends on the difficulty they solved (up to 2× luck bonus).
The same user can win any number of blocks.

- 📐 Full explanation (Hinglish): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- 📜 Contract: [`contracts/contracts/PowInscription.sol`](contracts/contracts/PowInscription.sol)
- 🌐 Web miner (phone + desktop): [`web/`](web)
- 🖥️ CLI miner: [`miner-cli/`](miner-cli)
- 🧠 Shared mining core + WebGPU Keccak kernel: [`shared/`](shared)

## Quick start (local)

```bash
npm install
npm test
cd contracts && npx hardhat node                     # terminal 1
MIN_DIFFICULTY_BITS=8 INITIAL_DIFFICULTY_BITS=16 \
  npx hardhat run scripts/deploy.js --network localhost   # terminal 2 (in contracts/)
npm run web                                          # terminal 3 → http://localhost:5173
```

Project files: https://drive.google.com/drive/folders/1OLUHKGNSBcwCrs_PhZlf9YrtMuk2QPSU?usp=sharing

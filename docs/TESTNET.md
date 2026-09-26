# Robinhood Chain Testnet Launch Checklist (Hinglish)

Pehle testnet → sab theek chala → phir mainnet.

## Network details
| | |
|---|---|
| Chain ID | `46630` |
| RPC | `https://rpc.testnet.chain.robinhood.com/rpc` |
| Explorer | https://explorer.testnet.chain.robinhood.com |
| Faucet | https://faucet.testnet.chain.robinhood.com (backup: https://faucet.quicknode.com/robinhood/testnet) |
| Gas token | ETH |

(Official source: https://docs.robinhood.com/chain/connecting — deploy se pehle ek baar match kar lena.)

## Step 1: Wallet ready karo
1. MetaMask mein **naya alag wallet/account** banao, sirf testnet ke liye. Asli paise wala wallet use mat karna.
2. Faucet page pe "Add chain" se Robinhood Chain Testnet add karo.
3. Faucet se testnet ETH lo (deploy ke liye thoda sa kaafi hai).
4. MetaMask → Account details → **Show private key** → copy.

## Step 2: Deploy
```bash
cd project-new-
npm install                                  # agar pehle nahi kiya
copy contracts\.env.example contracts\.env   # Windows
# cp contracts/.env.example contracts/.env   # Mac/Linux
```
`contracts/.env` kholo aur bharo:
```
PRIVATE_KEY=0x<tera testnet private key>
TOKEN_NAME=Robin PoW
TOKEN_SYMBOL=XYZ
MIN_DIFFICULTY_BITS=16
INITIAL_DIFFICULTY_BITS=22
```
Phir:
```bash
npm run deploy:testnet
```
Output aisa aayega:
```
Network : robinhoodTestnet (chainId 46630)
Deployer: 0x...  balance 0.5 ETH
PowInscription deployed at: 0xABC...
Explorer: https://explorer.testnet.chain.robinhood.com/address/0xABC...
wrote ../web/src/deployment.json
wrote ../miner-cli/deployment.json
```
**Contract address save kar lo.** `web/src/deployment.json` aur `miner-cli/deployment.json` ab testnet ko point karte hain. Inko git mein commit karo taaki website live contract use kare.

## Step 3: Apne PC pe test karo
```bash
npm run web          # http://localhost:5173
```
- **Connect wallet** (MetaMask testnet pe) ya **Use burner**. Burner ho toh uske address pe faucet se ya MetaMask se thoda ETH bhejo.
- **Start mining** → block solve → mint → Explorer pe tx dikhega.

CLI se bhi: `miner-cli/.env` mein `PRIVATE_KEY=...` daalo, phir `npm run mine`.

## Step 4: Website live karo (phone users ke liye, HTTPS)
**Vercel (free):**
1. Code GitHub pe push karo (deployment.json ke saath).
2. vercel.com → New Project → yeh repo choose karo → Root directory = repo root (`vercel.json` already hai) → Deploy.
3. Jo `https://...vercel.app` link mile, woh phone pe kholo → mine karo. HTTPS pe phone GPU (WebGPU) bhi chalega.

## Step 5: Testnet pe kya kya check karna hai (mainnet se pehle)
- [ ] 2-3 alag log (phone + PC) ek saath mine karein. Sirf ek hi jeete har block, baaki ko "someone else mined this block" aaye
- [ ] Block time dekho. 32 blocks ke baad difficulty adjust honi chahiye (Explorer pe `Retarget` event)
- [ ] 10+ min koi mine na kare → difficulty aasaan hoti hai (stall rescue)
- [ ] Reward amounts sahi (bonus bits ke hisaab se)
- [ ] Gas cost per mint note karo (users ko kitna ETH chahiye)
- [ ] Tokens wallet mein dikh rahe hain (MetaMask → Import token → contract address)
- [ ] Parameters final karo: reward, block time, max supply, difficulty (inke liye contract constants badalne padenge → naya deploy)

## Mainnet (baad mein)
- Contract ka **audit** karwao
- `contracts/.env` mein `RH_MAINNET_RPC`, `RH_MAINNET_CHAIN_ID` bharo (official docs se), `hardhat.config.js` mein `robinhood` network ready hai
- Mainnet ke liye bilkul fresh wallet + hardware wallet recommended

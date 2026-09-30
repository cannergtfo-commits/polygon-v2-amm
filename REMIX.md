# Deploy on Remix — Polygon PoS

Repo: https://github.com/cannergtfo-commits/polygon-v2-amm

## Network
- Chain: Polygon PoS mainnet
- Chain ID: 137
- Native gas token: POL
- Wrapped native (use this as Router WETH): `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270`
- Bridged WETH (actual ETH, not native wrap): `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619`
- Protocol feeTo: `0x6F47aa396215ab22647dDB3E86b4663DFe11dB14`

Do **not** deploy WETH9 on Polygon mainnet. Pass the wrapped-POL address above into the Router.

## Import this repo into Remix

1. Open https://remix.ethereum.org
2. Home tab → **GitHub** (or the GitHub plugin in the left bar)
3. Load: `https://github.com/cannergtfo-commits/polygon-v2-amm`
4. Or clone with remixd / download ZIP and drop the `remix/` folder into Remix.

You can also import a single flattened file:
```
https://github.com/cannergtfo-commits/polygon-v2-amm/blob/main/remix/Factory.sol
https://github.com/cannergtfo-commits/polygon-v2-amm/blob/main/remix/Router.sol
```

## Compiler
- Solidity **0.8.26**
- Language: Solidity
- EVM: paris (or default)
- Optimizer: **ON**, runs **999999**
- Auto compile ON

## Deploy order (Injected Provider — MetaMask on Polygon)

### 1. Factory
File: `remix/Factory.sol` → contract **Factory**

Constructor:
- `_feeToSetter`: your wallet (can change feeTo later)
- `_feeTo`: `0x6F47aa396215ab22647dDB3E86b4663DFe11dB14`

Save the Factory address.

### 2. Router
File: `remix/Router.sol` → contract **Router**

Constructor:
- `_factory`: Factory address from step 1
- `_WETH`: `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270`

### 3. (Optional test token)
File: `remix/MockERC20.sol` only if you need a dummy token.
On mainnet use real tokens (USDC, WETH, etc.).

## After deploy
Paste addresses into `frontend/config.js`:
```
chainId: 137
nativeSymbol: "POL"
factory: "0x..."
router: "0x..."
weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
feeTo: "0x6F47aa396215ab22647dDB3E86b4663DFe11dB14"
```
Serve the `frontend/` folder as static files.

## Amoy testnet (chain 80002)
Deploy `remix/WETH9.sol` first, then Factory, then Router(factory, weth9).
Get test POL from the Polygon faucet.

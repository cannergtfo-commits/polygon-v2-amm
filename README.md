# Polygon V2 AMM

Uniswap V2-style constant-product DEX for **Polygon PoS (chain 137)**.

- Swap fee: **0.30%**
- Protocol fee: **0.05% of volume** (1/6 of the swap fee), minted as LP to `0x6F47aa396215ab22647dDB3E86b4663DFe11dB14`
- Static frontend in `frontend/`
- Remix-ready flattened contracts in `remix/`

Public repo: https://github.com/cannergtfo-commits/polygon-v2-amm

## Remix deploy (Polygon)

Full steps: [REMIX.md](./REMIX.md)

Short version:

1. Open [remix.ethereum.org](https://remix.ethereum.org)
2. GitHub plugin → load `cannergtfo-commits/polygon-v2-amm`
3. Compiler `0.8.26`, optimizer ON, runs `999999`
4. Environment: **Injected Provider** — MetaMask on Polygon
5. Deploy `remix/Factory.sol` → **Factory**
   - `_feeToSetter`: your wallet
   - `_feeTo`: `0x6F47aa396215ab22647dDB3E86b4663DFe11dB14`
6. Deploy `remix/Router.sol` → **Router**
   - `_factory`: address from step 5
   - `_WETH`: `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270` (wrapped POL)

Do not deploy `WETH9.sol` on Polygon mainnet. That file is for Amoy only.

## Addresses

See [POLYGON.md](./POLYGON.md).

| Role | Address |
|---|---|
| Wrapped POL (Router WETH) | `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270` |
| Protocol feeTo | `0x6F47aa396215ab22647dDB3E86b4663DFe11dB14` |

## Frontend

Static HTML. After deploy, edit `frontend/config.js` and host the folder.

## License

GPL-3.0-or-later. AMM math follows the Uniswap V2 whitepaper. Not audited.

# Markarian 421

Receipt token for an equal-value basket of BzB, WBTC, and WETH on Polygon PoS. Stake the receipt to earn BzB.

Bitcoin, Ether, and a blazar bit walked into a jet and only one object came out. Markarian 421 is that receipt: equal parts digital gold, digital gas, and actual BlazarBits, pointed at the real Markarian 421 like it has somewhere to be. It does not pulse in radio. It just lets you leave with your third.

| | |
|---|---|
| Vault | `0x213C7a13CC3C8A519867FA29cB010c575FBBB4F8` |
| M421 | `0xd2aD34cab1fc6ee954276d28c67E219875397420` |
| Staking | `0x3d8C5cB54B3E2a18cf6F8015833aAC6B484Df72E` |
| BzB | `0x462d8d82c2b2d2ddabf7f8a93928de09d47a5807` |
| WBTC | `0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6` |
| WETH | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` |

- First deposit must be at least $10 total and within 5% of equal dollar value. Chainlink prices WBTC and WETH. BzB is quoted on QuickSwap.
- Later deposits match the basket. Extra tokens are refunded.
- Burning M421 returns that percentage of all three tokens.
- An empty-basket zap sells the input in equal thirds. Zap out sells the other two into one token.
- Staking uses Synthetix reward-per-token accounting. The rate is fixed: 500 BzB/day for 100 days, 250 for the next 100, then 100. Send BzB to the staking contract. Unfunded time and time with nobody staked is not back-paid.
- Neither contract has an owner.

Vault deploy: `0x354793457cd7a1e367e11b3cea07fc5511a8741fd281ff36b979f4cd7e006db7`

Staking deploy: `0xd2ff758bc23e78f75b4b9c5cc0cae35eab6dd01524044db94ea3fe427d75ef47`

Sources: `Markarian421.sol`, `MarkarianVault.sol`, `M421StakingRewards.sol`.

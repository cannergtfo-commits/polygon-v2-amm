/* Polygon PoS — paste Factory + Router after Remix deploy */
window.DEX = {
  name: "V2 Exchange",
  chainId: 137,
  nativeSymbol: "POL",
  factory: "0x0000000000000000000000000000000000000000",
  router: "0x0000000000000000000000000000000000000000",
  weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  feeTo: "0x6F47aa396215ab22647dDB3E86b4663DFe11dB14",
  swapFeeBps: 30,
  protocolFeeBps: 5,
  explorer: "https://polygonscan.com",
  tokens: [
    { symbol: "WPOL", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
    { symbol: "USDC.e", address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 }
  ]
};

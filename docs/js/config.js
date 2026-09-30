window.BLAZARSWAP = {
  appName: "BlazarSwap",
  chainId: 137,
  chainName: "Polygon",
  rpcUrl: "https://1rpc.io/matic",
  rpcUrls: ["https://1rpc.io/matic", "https://polygon.drpc.org", "https://polygon-bor-rpc.publicnode.com"],
  explorer: "https://polygonscan.com",
  nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  factory: "0x8e9663F4b15F3B291B1354e20d1B019d8864830F",
  router: "0x5C0cCC397A5B222B06815C3c23959dd83F42aA86",
  baseToken: "0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807",
  weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  feeTo: "0x6F47aa396215ab22647dDB3E86b4663DFe11dB14",
  protocolFeeBps: 5,
  lpFeeBps: 25,
  totalFeeBps: 30,
  tokens: [
    { symbol: "BzB", name: "BlazarBits", address: "0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807", decimals: 18, isBase: true, logo: "https://i.imgur.com/BiGUlnC.png" },
    { symbol: "WPOL", name: "Wrapped POL", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, logo: "https://polygonscan.com/token/images/polygonmatic_new_32.png" },
    { symbol: "USDC", name: "USD Coin", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, logo: "https://polygonscan.com/token/images/centre-usdc_32.png" },
    { symbol: "WBTC", name: "Wrapped BTC", address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8, logo: "https://polygonscan.com/token/images/wbtc_32.png" },
    { symbol: "USDT", name: "Tether USD", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, logo: "https://polygonscan.com/token/images/tether_32.png" },
    { symbol: "WETH", name: "Wrapped Ether", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, logo: "https://polygonscan.com/token/images/weth_32.png" }
  ]
};

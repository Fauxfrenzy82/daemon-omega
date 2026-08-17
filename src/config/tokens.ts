yexport interface TokenInfo {
  chainId: number;
  address: string;
  decimals: number;
  symbol: string;
  name: string;
}

export const TOKENS: Record<string, TokenInfo> = {
  USDC: {
    chainId: 137,
    address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    decimals: 6,
    symbol: 'USDC',
    name: 'USD Coin',
  },
  USDCe: {
    chainId: 137,
    address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    decimals: 6,
    symbol: 'USDC.e',
    name: 'Bridged USDC',
  },
  USDT: {
    chainId: 137,
    address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    decimals: 6,
    symbol: 'USDT',
    name: 'Tether USD',
  },
  DAI: {
    chainId: 137,
    address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    decimals: 18,
    symbol: 'DAI',
    name: 'Dai Stablecoin',
  },
  WETH: {
    chainId: 137,
    address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    decimals: 18,
    symbol: 'WETH',
    name: 'Wrapped Ether',
  },
  WMATIC: {
    chainId: 137,
    address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    decimals: 18,
    symbol: 'WMATIC',
    name: 'Wrapped Matic',
  },
  WBTC: {
    chainId: 137,
    address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
    decimals: 8,
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
  },
  LINK: {
    chainId: 137,
    address: '0x53E0bca35eC356BD5dDDFebbD1Fc0fD03FaBad39',
    decimals: 18,
    symbol: 'LINK',
    name: 'ChainLink Token',
  },
  AAVE: {
    chainId: 137,
    address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B',
    decimals: 18,
    symbol: 'AAVE',
    name: 'Aave Token',
  },
  // Verified via GHST's own dedicated PolygonScan token page (established
  // Aavegotchi game ecosystem token, not a wallet-holding artifact).
  GHST: {
    chainId: 137,
    address: '0x385Eeac5cB85A38A9a07A70c73e0a3271CfB54A7',
    decimals: 18,
    symbol: 'GHST',
    name: 'Aavegotchi GHST Token',
  },
  // Verified via PolygonScan's own migration banner + independent MEXC
  // exchange announcements (multiple sources agree). QUICK migrated
  // contracts in 2023 with a 1:1000 redenomination — the old address
  // (0x831753dd...) is explicitly deprecated; this is the current one.
  QUICK: {
    chainId: 137,
    address: '0xB5C064F955D8e7F38fE0460C556a72987494eE17',
    decimals: 18,
    symbol: 'QUICK',
    name: 'QuickSwap',
  },
};

export function getToken(symbol: string): TokenInfo {
  const t = TOKENS[symbol];
  if (!t) throw new Error(`Unknown token symbol: ${symbol}`);
  return t;
}
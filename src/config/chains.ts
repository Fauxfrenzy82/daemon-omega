import { env } from './env';

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  wsUrl?: string;
  nativeSymbol: string;
  explorerUrl: string;
}

export const POLYGON: ChainConfig = {
  chainId: 137,
  name: 'polygon',
  rpcUrl: env.RPC_URL,
  wsUrl: env.RPC_WS_URL || undefined,
  nativeSymbol: 'POL',
  explorerUrl: 'https://polygonscan.com',
};

export const activeChain: ChainConfig =
  env.CHAIN_ID === 137 ? POLYGON : (() => {
    throw new Error(`Unsupported CHAIN_ID: ${env.CHAIN_ID}`);
  })();
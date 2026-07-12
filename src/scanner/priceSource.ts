import { TokenInfo } from '../config/tokens';

export interface QuoteRequest {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string; // in tokenIn's smallest unit, as string
}

export interface QuoteResult {
  source: string; // 'uniswapv3' | 'paraswapv5' | 'openoceanv2' | 'balancerv2'
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  amountOut: string; // in tokenOut's smallest unit, as string
  price: number; // tokenOut per tokenIn (human units)
  estLiquidityUsd?: number;
  raw?: unknown; // source-specific payload for execution building
}

export interface PriceSource {
  name: string;
  getQuote(req: QuoteRequest): Promise<QuoteResult | null>;
}
import { TokenInfo } from '../config/tokens';

export interface QuoteRequest {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string; // in tokenIn's smallest unit, as string
}

export interface QuoteResult {
  source: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  amountOut: string; // in tokenOut's smallest unit, as string
  price: number; // tokenOut per tokenIn (human units)
  estLiquidityUsd?: number;
  raw?: unknown;
  supportsExecution: boolean; // NEW: indicates if this source can execute trades
}

export interface PriceSource {
  name: string;
  supportsExecution: boolean; // NEW: indicates if this source can execute trades
  getQuote(req: QuoteRequest): Promise<QuoteResult | null>;
}
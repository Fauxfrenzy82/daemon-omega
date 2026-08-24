import { TokenInfo } from '../../config/tokens';

export interface OpportunityCandidate {
  id: string;
  strategy: 'debtPosition' | 'vaultArb' | 'lpEntryExit' | 'harvestShort' | 'classicIncentive';
  protocol: string;
  params: Record<string, any>;
  estimatedGrossProfitUsd: number;
  estimatedNetProfitUsd: number;
  estimatedCostUsd: number;
  actionPlan: ActionPlan | null;
  sourceTimestamp: number;
}

export interface ActionPlan {
  flashLoanToken: TokenInfo;
  flashLoanAmount: string;
  steps: ActionStep[];
}

export type FlashloanProtocol = 
  | 'aave-v3'
  | 'morpho-markets-v1'
  | 'balancer-v3'
  | 'uniswap-v3'
  | 'dolomite'
  | 'bend'
  | 'hyperlend'
  | 'kodiak';

/**
 * ✅ CORRECTED ActionStep model for flashloans.
 * 
 * The key distinction:
 * - token/amount: the flash-borrowed asset (flashloanToken/flashloanAmount)
 * - tokenIn/amountIn: USER-SUPPLIED input/collateral (optional, semantically different)
 * - tokenOut: expected callback output (optional)
 * 
 * These are NOT interchangeable.
 */
export type ActionStep =
  | { 
      type: 'flashloan'; 
      protocol: FlashloanProtocol; 
      token: string;           // flashloanToken
      amount: string;          // flashloanAmount
      tokenIn?: string | string[];      // User-supplied input (optional)
      amountIn?: string | string[] | { useOutputOfCallAt: number }; // Matching user input
      tokenOut?: string | string[];     // Expected callback output (optional)
      callback: ActionStep[];
      primaryAddress?: string;
      receiver?: string;
    }
  | { type: 'swap'; protocol: 'enso'; tokenIn: string; tokenOut: string; amountIn: string | { useOutputOfCallAt: number }; slippage: string; primaryAddress?: string; poolFee?: number }
  | { type: 'deposit'; protocol: 'aave-v3' | 'stata'; token: string; amount: string | { useOutputOfCallAt: number }; primaryAddress?: string }
  | { type: 'withdraw'; protocol: 'aave-v3' | 'stata'; token: string; amount: string | { useOutputOfCallAt: number }; primaryAddress?: string }
  | { type: 'harvest'; protocol: 'enso'; positionAddress: string; token?: string }
  | { type: 'call'; protocol: 'custom'; target: string; data: string; value?: string; useOutput?: boolean };
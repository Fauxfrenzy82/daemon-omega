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

export type ActionStep =
  | { 
      type: 'flashloan'; 
      protocol: FlashloanProtocol; 
      token: string; 
      tokenIn?: string;       // Will be converted to array in ensoBuilder
      amountIn?: string;      // Will be converted to array in ensoBuilder
      amount: string; 
      callback: ActionStep[] 
    }
  | { type: 'swap'; protocol: 'enso'; tokenIn: string; tokenOut: string; amountIn: string | { useOutputOfCallAt: number }; slippage: string; primaryAddress?: string; poolFee?: number }
  | { type: 'deposit'; protocol: 'aave-v3' | 'stata'; token: string; amount: string | { useOutputOfCallAt: number }; primaryAddress?: string }
  | { type: 'withdraw'; protocol: 'aave-v3' | 'stata'; token: string; amount: string | { useOutputOfCallAt: number }; primaryAddress?: string }
  | { type: 'harvest'; protocol: 'enso'; positionAddress: string; token?: string }
  | { type: 'call'; protocol: 'custom'; target: string; data: string; value?: string; useOutput?: boolean };
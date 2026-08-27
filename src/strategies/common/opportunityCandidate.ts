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
 * ActionStep types – receiver and refundReceiver are optional
 * but should NOT be used in the flashloan action root.
 * They are handled at the bundle level via fromAddress.
 */
export type ActionStep =
  | { 
      type: 'flashloan'; 
      protocol: FlashloanProtocol; 
      token: string;
      amount: string;
      tokenIn?: string | string[];
      amountIn?: string | string[] | { useOutputOfCallAt: number };
      tokenOut?: string | string[];
      callback: ActionStep[];
      primaryAddress?: string;
      // 🔥 These are NOT used in the action – handled at bundle level
      receiver?: string;
      refundReceiver?: string;
    }
  | { type: 'swap'; protocol: 'enso'; tokenIn: string; tokenOut: string; amountIn: string | { useOutputOfCallAt: number }; slippage: string; primaryAddress?: string; poolFee?: number }
  | { type: 'deposit'; protocol: 'aave-v3' | 'stata'; token: string; amount: string | { useOutputOfCallAt: number }; primaryAddress?: string; onBehalfOf?: string }
  | { type: 'withdraw'; protocol: 'aave-v3' | 'stata'; token: string; amount: string | { useOutputOfCallAt: number }; primaryAddress?: string }
  | { type: 'harvest'; protocol: 'enso'; positionAddress: string; token?: string }
  | { type: 'borrow'; protocol: 'aave-v3'; collateral: string; token: string; amount: string; primaryAddress?: string; onBehalfOf?: string; interestRateMode?: number }
  | { type: 'call'; protocol: 'custom'; target: string; data: string; value?: string; useOutput?: boolean };
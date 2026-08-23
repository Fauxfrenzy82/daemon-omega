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

/**
 * Valid flashloan protocols per Enso documentation:
 * https://docs.enso.build/pages/build/reference/flashloans
 */
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
 * ActionStep defines all possible actions in an Enso Bundle.
 * - flashloan: Borrow tokens without collateral (uses supported lending protocols)
 * - swap: Token swap via Enso routing (protocol: 'enso')
 * - deposit: Deposit into lending protocol (Aave V3, StataToken)
 * - withdraw: Withdraw from lending protocol (Aave V3, StataToken)
 * - harvest: Claim rewards from a yield position (protocol: 'enso')
 * - call: Raw contract call (protocol: 'custom')
 */
export type ActionStep =
  | { type: 'flashloan'; protocol: FlashloanProtocol; token: string; amount: string; callback: ActionStep[] }
  | { type: 'swap'; protocol: 'enso'; tokenIn: string; tokenOut: string; amountIn: string | { useOutputOfCallAt: number }; slippage: string; primaryAddress?: string; poolFee?: number }
  | { type: 'deposit'; protocol: 'aave-v3' | 'stata'; token: string; amount: string | { useOutputOfCallAt: number }; primaryAddress?: string }
  | { type: 'withdraw'; protocol: 'aave-v3' | 'stata'; token: string; amount: string | { useOutputOfCallAt: number }; primaryAddress?: string }
  | { type: 'harvest'; protocol: 'enso'; positionAddress: string; token?: string }
  | { type: 'call'; protocol: 'custom'; target: string; data: string; value?: string; useOutput?: boolean };
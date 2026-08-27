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
 * ✅ FIXED: Added refundReceiver to flashloan ActionStep
 * 
 * Address type rules for flashloan actions:
 * - token / amount: The flash-borrowed asset (ERC-20 token address)
 * - tokenIn / amountIn: Additional user-supplied input (optional)
 * - tokenOut: Expected callback output (optional)
 * - receiver: EOA or Smart Contract Wallet receiving the flash-borrowed funds
 * - refundReceiver: EOA or Smart Contract Wallet receiving surplus/dust
 * - primaryAddress: Protocol contract address (e.g., Aave Pool)
 * - onBehalfOf: EOA or Smart Contract Wallet (for Aave actions)
 */
export type ActionStep =
  | { 
      type: 'flashloan'; 
      protocol: FlashloanProtocol; 
      token: string;           // flashloanToken (ERC-20 address)
      amount: string;          // flashloanAmount
      tokenIn?: string | string[];      // User-supplied input (optional)
      amountIn?: string | string[] | { useOutputOfCallAt: number };
      tokenOut?: string | string[];     // Expected callback output (optional)
      callback: ActionStep[];
      primaryAddress?: string; // Protocol address (e.g., Aave Pool)
      receiver?: string;       // EOA / Smart Contract Wallet (receives flash-borrowed funds)
      refundReceiver?: string; // EOA / Smart Contract Wallet (receives surplus/dust) 
      onBehalfOf?: string;     // EOA / Smart Contract Wallet (for Aave actions)
    }
  | { type: 'swap'; protocol: 'enso'; tokenIn: string; tokenOut: string; amountIn: string | { useOutputOfCallAt: number }; slippage: string; primaryAddress?: string; poolFee?: number }
  | { type: 'deposit'; protocol: 'aave-v3' | 'stata'; token: string; amount: string | { useOutputOfCallAt: number }; primaryAddress?: string; onBehalfOf?: string }
  | { type: 'withdraw'; protocol: 'aave-v3' | 'stata'; token: string; amount: string | { useOutputOfCallAt: number }; primaryAddress?: string }
  | { type: 'harvest'; protocol: 'enso'; positionAddress: string; token?: string }
  | { type: 'borrow'; protocol: 'aave-v3'; collateral: string; token: string; amount: string; primaryAddress?: string; onBehalfOf?: string; interestRateMode?: number }
  | { type: 'call'; protocol: 'custom'; target: string; data: string; value?: string; useOutput?: boolean };
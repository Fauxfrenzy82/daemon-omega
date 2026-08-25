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
      // token/amount = what gets flash-borrowed
      token: string;
      amount: string;
      callback: ActionStep[];
      primaryAddress?: string;
      receiver?: string;
      // legacy fields no longer sent to Enso — kept for internal reference only
      tokenIn?: string | string[];
      amountIn?: string | string[] | { useOutputOfCallAt: number };
      tokenOut?: string | string[];
    }
  | {
      type: 'swap';
      protocol: 'enso';
      tokenIn: string;
      tokenOut: string;
      amountIn: string | { useOutputOfCallAt: number };
      slippage: string;
      primaryAddress?: string;
      poolFee?: number;
    }
  | {
      // Maps to Enso's deposit action: args.tokenIn / args.amountIn
      type: 'deposit';
      protocol: 'aave-v3' | 'stata';
      token: string;
      amount: string | { useOutputOfCallAt: number };
      primaryAddress?: string;
    }
  | {
      // Maps to Enso's redeem action: args.tokenIn / args.amountIn
      type: 'withdraw';
      protocol: 'aave-v3' | 'stata';
      token: string;
      amount: string | { useOutputOfCallAt: number };
      primaryAddress?: string;
    }
  | {
      // Maps to Enso's borrow action: args.collateral / args.tokenOut / args.amountOut
      type: 'borrow';
      protocol: 'aave-v3';
      collateral: string;   // address of token used as collateral
      token: string;        // address of token to borrow (maps to tokenOut)
      amount: string | { useOutputOfCallAt: number }; // amount to borrow (maps to amountOut)
      primaryAddress?: string;
    }
  | {
      type: 'harvest';
      protocol: 'enso';
      positionAddress: string;
      token?: string;
    }
  | {
      type: 'call';
      protocol: 'custom';
      target: string;
      data: string;
      value?: string;
      useOutput?: boolean;
    };
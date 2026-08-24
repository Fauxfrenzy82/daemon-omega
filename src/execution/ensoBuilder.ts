import { ethers } from 'ethers';
import { TokenInfo } from '../config/tokens';
import { EvaluatedOpportunity } from '../profitability/evaluator';
import { executionWallet } from '../treasury/wallets';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import { getEnsoClient } from './ensoClient';
import { ActionPlan, ActionStep } from '../strategies/common/opportunityCandidate';

const log = createLogger('ensoBuilder');

export interface BuiltBundle {
  bundleData: any;
  flashLoanAmount: string;
  flashLoanToken: TokenInfo;
}

export interface FlashLoanProvider {
  name: string;
  protocol: 'aave-v3' | 'morpho-markets-v1' | 'balancer-v3' | 'uniswap-v3';
}

const bundleCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL_MS = 10000;

export const FLASH_LOAN_PROVIDERS: FlashLoanProvider[] = [
  { name: 'Aave V3', protocol: 'aave-v3' },
  { name: 'Morpho', protocol: 'morpho-markets-v1' },
];

/**
 * Convert an ActionStep to an Enso-compatible action object.
 * Supports all action types: flashloan, swap, deposit, withdraw, harvest, call.
 */
function convertStepToEnsoAction(step: ActionStep, context: { flashLoanAmount: string }): any {
  switch (step.type) {
    case 'flashloan':
      return {
        protocol: step.protocol,
        action: 'flashloan',
        args: {
          flashloanToken: step.token,
          flashloanAmount: step.amount,
          tokenOut: [step.token],
          // FIX: Add tokenIn if provided (required by Aave V3 flashloan)
          ...(step.tokenIn ? { tokenIn: step.tokenIn } : {}),
          callback: step.callback.map(s => convertStepToEnsoAction(s, context)),
        },
      };
    case 'swap':
      return {
        protocol: 'enso',
        action: 'route',
        args: {
          tokenIn: step.tokenIn,
          tokenOut: step.tokenOut,
          amountIn: typeof step.amountIn === 'string' ? step.amountIn : { useOutputOfCallAt: step.amountIn.useOutputOfCallAt },
          slippage: step.slippage,
          ...(step.primaryAddress ? { primaryAddress: step.primaryAddress } : {}),
          ...(step.poolFee !== undefined ? { poolFee: step.poolFee } : {}),
        },
      };
    case 'deposit':
      return {
        protocol: step.protocol,
        action: 'deposit',
        args: {
          token: step.token,
          amount: typeof step.amount === 'string' ? step.amount : { useOutputOfCallAt: step.amount.useOutputOfCallAt },
          ...(step.primaryAddress ? { primaryAddress: step.primaryAddress } : {}),
        },
      };
    case 'withdraw':
      return {
        protocol: step.protocol,
        action: 'withdraw',
        args: {
          token: step.token,
          amount: typeof step.amount === 'string' ? step.amount : { useOutputOfCallAt: step.amount.useOutputOfCallAt },
          ...(step.primaryAddress ? { primaryAddress: step.primaryAddress } : {}),
        },
      };
    case 'harvest':
      return {
        protocol: 'enso',
        action: 'harvest',
        args: {
          positionAddress: step.positionAddress,
          ...(step.token ? { token: step.token } : {}),
        },
      };
    case 'call':
      return {
        protocol: 'custom',
        action: 'call',
        args: {
          target: step.target,
          data: step.data,
          value: step.value || '0',
          useOutput: step.useOutput || false,
        },
      };
    default:
      throw new Error(`Unsupported action step type: ${(step as any).type}`);
  }
}

export async function buildBundleFromPlan(plan: ActionPlan): Promise<BuiltBundle> {
  const enso = getEnsoClient();
  const chainId = activeChain.chainId;
  const fromAddress = ethers.utils.getAddress(executionWallet.address) as `0x${string}`;

  // Build actions array from plan steps
  const actions = plan.steps.map(step => convertStepToEnsoAction(step, { flashLoanAmount: plan.flashLoanAmount }));

  const bundleParams = {
    fromAddress,
    chainId,
    routingStrategy: 'router' as const,
  };

  const cacheKey = `${JSON.stringify(actions)}`;
  const cached = bundleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    log.info(`✅ Using cached bundle for plan`);
    return {
      bundleData: cached.data,
      flashLoanAmount: plan.flashLoanAmount,
      flashLoanToken: plan.flashLoanToken,
    };
  }

  try {
    const bundleData = await enso.getBundleData(bundleParams, actions as any);
    bundleCache.set(cacheKey, { data: bundleData, timestamp: Date.now() });
    log.info('✅ Enso bundle created from plan');
    return {
      bundleData,
      flashLoanAmount: plan.flashLoanAmount,
      flashLoanToken: plan.flashLoanToken,
    };
  } catch (error: any) {
    const isEnsoApiError = error?.constructor?.name === 'EnsoApiError';
    if (error?.statusCode === 429 || error?.response?.status === 429) {
      log.warn(`⏳ Rate limited, caching failure for ${CACHE_TTL_MS}ms`);
      bundleCache.set(cacheKey, { data: null, timestamp: Date.now() });
    } else {
      log.error(`❌ Enso API error building bundle`, {
        isEnsoApiError,
        statusCode: error?.statusCode || error?.response?.status,
        responseData: error?.responseData || error?.response?.data,
        message: error?.message,
      });
    }
    throw error;
  }
}

// Legacy function kept for backward compatibility, but deprecated
export async function buildArbitrageBundle(
  opp: EvaluatedOpportunity,
  flashLoanToken: TokenInfo,
  flashLoanAmountRaw: string,
  provider: FlashLoanProvider,
  options: { buyRequiresRequote?: boolean; sellRequiresRequote?: boolean } = {}
): Promise<BuiltBundle> {
  // This is now deprecated; use buildBundleFromPlan with ActionPlan
  log.warn('buildArbitrageBundle is deprecated, use buildBundleFromPlan with ActionPlan');
  throw new Error('Deprecated: use buildBundleFromPlan with ActionPlan');
}
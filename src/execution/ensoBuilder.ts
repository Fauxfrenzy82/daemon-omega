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
 * ✅ CORRECTED: Convert an ActionStep to an Enso-compatible action object.
 * 
 * Based on Enso's official flashloan schema:
 * - flashloanToken/flashloanAmount: the asset being flash-borrowed
 * - tokenIn/amountIn: ADDITIONAL assets supplied by the user (NOT the flashloan token)
 * - tokenOut: expected callback output
 * 
 * These are semantically different concepts and should NOT be conflated.
 */
function convertStepToEnsoAction(step: ActionStep, context: { flashLoanAmount: string }): any {
  switch (step.type) {
    case 'flashloan': {
      // ✅ Validate required fields
      if (!step.token) {
        throw new Error('Flashloan step missing flashloan token');
      }
      if (!step.amount) {
        throw new Error('Flashloan step missing flashloan amount');
      }
      if (!step.callback || step.callback.length === 0) {
        throw new Error('Flashloan must contain at least one callback action');
      }

      // ✅ Build args with flashloan token and amount
      const args: Record<string, any> = {
        flashloanToken: step.token,
        flashloanAmount: step.amount,
        callback: step.callback.map(s => convertStepToEnsoAction(s, context)),
      };

      // ✅ Only include tokenIn if this flashloan has user-supplied input
      // tokenIn is NOT the flashloan token – it's additional user collateral/input
      if (step.tokenIn) {
        args.tokenIn = Array.isArray(step.tokenIn) ? step.tokenIn : [step.tokenIn];

        if (step.amountIn === undefined) {
          throw new Error('Flashloan has tokenIn but no matching amountIn');
        }
        args.amountIn = Array.isArray(step.amountIn) ? step.amountIn : [step.amountIn];
      }

      // ✅ Only include tokenOut when the action plan specifies expected callback output
      if (step.tokenOut) {
        args.tokenOut = Array.isArray(step.tokenOut) ? step.tokenOut : [step.tokenOut];
      }

      // ✅ Optional fields
      if (step.primaryAddress) {
        args.primaryAddress = step.primaryAddress;
      }
      if (step.receiver) {
        args.receiver = step.receiver;
      }

      return {
        protocol: step.protocol,
        action: 'flashloan',
        args,
      };
    }
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

export async function buildArbitrageBundle(
  opp: EvaluatedOpportunity,
  flashLoanToken: TokenInfo,
  flashLoanAmountRaw: string,
  provider: FlashLoanProvider,
  options: { buyRequiresRequote?: boolean; sellRequiresRequote?: boolean } = {}
): Promise<BuiltBundle> {
  log.warn('buildArbitrageBundle is deprecated, use buildBundleFromPlan with ActionPlan');
  throw new Error('Deprecated: use buildBundleFromPlan with ActionPlan');
}
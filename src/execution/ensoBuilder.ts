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
 * Enso flashloan args schema (from official docs):
 * {
 *   protocol: "aave-v3",
 *   action: "flashloan",
 *   args: {
 *     flashloanToken: "0x...",   <-- SCALAR string for single token
 *     flashloanAmount: "12345",  <-- SCALAR string for single token
 *     callback: [...]
 *   }
 * }
 *
 * Arrays (string[]) are only used for multi-token flashloans.
 * Passing an array for a single token causes Enso to throw
 * "Invalid address type" because the address parser receives
 * an array where it expects a string.
 *
 * Enso deposit args:
 * { tokenIn, amountIn, primaryAddress }
 *
 * Enso borrow args:
 * { collateral, tokenOut, amountOut, primaryAddress }
 */
function convertStepToEnsoAction(step: ActionStep, context: { flashLoanAmount: string }): any {
  switch (step.type) {
    case 'flashloan': {
      if (!step.token) throw new Error('Flashloan step missing token');
      if (!step.amount) throw new Error('Flashloan step missing amount');
      if (!step.callback || step.callback.length === 0) {
        throw new Error('Flashloan must contain at least one callback action');
      }

      const args: Record<string, any> = {
        // Scalar strings for single-token flashloan — NOT arrays.
        // Arrays are only valid when borrowing multiple tokens simultaneously.
        flashloanToken: step.token,
        flashloanAmount: step.amount,
        callback: step.callback.map(s => convertStepToEnsoAction(s, context)),
      };

      if (step.primaryAddress) args.primaryAddress = step.primaryAddress;
      if (step.receiver) args.receiver = step.receiver;

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
          amountIn:
            typeof step.amountIn === 'string'
              ? step.amountIn
              : { useOutputOfCallAt: step.amountIn.useOutputOfCallAt },
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
          tokenIn: step.token,
          amountIn:
            typeof step.amount === 'string'
              ? step.amount
              : { useOutputOfCallAt: (step.amount as any).useOutputOfCallAt },
          ...(step.primaryAddress ? { primaryAddress: step.primaryAddress } : {}),
          ...(step.onBehalfOf ? { onBehalfOf: step.onBehalfOf } : {}), // <-- ADDED
        },
      };

    case 'withdraw':
      return {
        protocol: step.protocol,
        action: 'redeem',
        args: {
          tokenIn: step.token,
          amountIn:
            typeof step.amount === 'string'
              ? step.amount
              : { useOutputOfCallAt: (step.amount as any).useOutputOfCallAt },
          ...(step.primaryAddress ? { primaryAddress: step.primaryAddress } : {}),
        },
      };

    case 'borrow':
      return {
        protocol: step.protocol,
        action: 'borrow',
        args: {
          collateral: step.collateral,
          tokenOut: step.token,
          amountOut:
            typeof step.amount === 'string'
              ? step.amount
              : { useOutputOfCallAt: (step.amount as any).useOutputOfCallAt },
          ...(step.primaryAddress ? { primaryAddress: step.primaryAddress } : {}),
          ...(step.onBehalfOf ? { onBehalfOf: step.onBehalfOf } : {}), // <-- ADDED
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

  const actions = plan.steps.map(step =>
    convertStepToEnsoAction(step, { flashLoanAmount: plan.flashLoanAmount })
  );

  log.info('ENSO FLASHLOAN ACTION PAYLOAD', {
    action: JSON.stringify(actions[0], null, 2),
  });

  const bundleParams = {
    fromAddress,
    chainId,
    routingStrategy: 'router' as const,
  };

  const cacheKey = JSON.stringify(actions);
  bundleCache.delete(cacheKey);

  const cached = bundleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    log.info('✅ Using cached bundle for plan');
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
      log.error('❌ Enso API error building bundle', {
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
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
 *
 * Enso flashloan args schema (from official docs):
 * {
 *   protocol: 'aave-v3',
 *   action: 'flashloan',
 *   args: {
 *     flashloanToken: '0x...',    <-- token to borrow (inside args)
 *     flashloanAmount: '12345',   <-- amount to borrow (inside args)
 *     callback: [...]             <-- callback actions (inside args)
 *   }
 * }
 *
 * Enso deposit args schema:
 * {
 *   protocol: 'aave-v3',
 *   action: 'deposit',
 *   args: {
 *     tokenIn: '0x...',
 *     amountIn: '12345',
 *     primaryAddress: '0x...'
 *   }
 * }
 *
 * Enso borrow args schema:
 * {
 *   protocol: 'aave-v3',
 *   action: 'borrow',
 *   args: {
 *     collateral: '0x...',
 *     tokenOut: '0x...',
 *     amountOut: '12345',
 *     primaryAddress: '0x...'
 *   }
 * }
 */
function convertStepToEnsoAction(
  step: ActionStep,
  context: { flashLoanAmount: string }
): any {
  switch (step.type) {
    case 'flashloan': {
      if (!step.token) {
        throw new Error('Flashloan step missing token');
      }
      if (!step.amount) {
        throw new Error('Flashloan step missing amount');
      }
      if (!step.callback || step.callback.length === 0) {
        throw new Error('Flashloan must contain at least one callback action');
      }

      // Enso flashloan args use flashloanToken / flashloanAmount
      // inside the args object — NOT tokenIn/amountIn, NOT at root level.
      const args: Record<string, any> = {
        flashloanToken: step.token,
        flashloanAmount: step.amount,
        callback: step.callback.map(s => convertStepToEnsoAction(s, context)),
      };

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
      // Enso deposit uses tokenIn / amountIn (confirmed from official docs)
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
      // Enso borrow uses collateral / tokenOut / amountOut (confirmed from official docs)
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
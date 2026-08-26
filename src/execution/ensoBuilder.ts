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
 *     flashloanToken: "0x...",   
 *     flashloanAmount: "12345",  
 *     callback: [...]
 *   }
 * }
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
        flashloanToken: ethers.utils.getAddress(step.token),
        flashloanAmount: step.amount.toString(),
        callback: step.callback.map(s => convertStepToEnsoAction(s, context)),
      };

      if (step.primaryAddress) args.primaryAddress = ethers.utils.getAddress(step.primaryAddress);
      if (step.receiver) args.receiver = ethers.utils.getAddress(step.receiver);

      log.info('FLASHLOAN STEP CONVERTED', {
        args: JSON.stringify(args, null, 2),
      });

      return {
        protocol: step.protocol,
        action: 'flashloan',
        args,
      };
    }

    case 'swap': {
      const args = {
        tokenIn: ethers.utils.getAddress(step.tokenIn),
        tokenOut: ethers.utils.getAddress(step.tokenOut),
        amountIn:
          typeof step.amountIn === 'string'
            ? step.amountIn
            : { useOutputOfCallAt: step.amountIn.useOutputOfCallAt },
        slippage: step.slippage,
        ...(step.primaryAddress ? { primaryAddress: ethers.utils.getAddress(step.primaryAddress) } : {}),
        ...(step.poolFee !== undefined ? { poolFee: step.poolFee } : {}),
      };

      log.info('SWAP STEP CONVERTED', {
        args: JSON.stringify(args, null, 2),
      });

      return {
        protocol: 'enso',
        action: 'route',
        args,
      };
    }

    case 'deposit': {
      const isNestedInFlashloan = context.flashLoanAmount !== '';

      const args = {
        tokenIn: ethers.utils.getAddress(step.token),
        amountIn: isNestedInFlashloan
          ? { useOutputOfCallAt: 0 } // Dynamically targets the parent flashloan token output index
          : typeof step.amount === 'string'
            ? step.amount
            : { useOutputOfCallAt: (step.amount as any).useOutputOfCallAt },
        ...(step.primaryAddress ? { primaryAddress: ethers.utils.getAddress(step.primaryAddress) } : {}),
        ...(step.onBehalfOf ? { onBehalfOf: ethers.utils.getAddress(step.onBehalfOf) } : {}),
      };

      log.info('DEPOSIT STEP CONVERTED', {
        args: JSON.stringify(args, null, 2),
        hasOnBehalfOf: !!step.onBehalfOf,
        onBehalfOfValue: step.onBehalfOf,
      });

      return {
        protocol: step.protocol,
        action: 'deposit',
        args,
      };
    }

    case 'withdraw': {
      const args = {
        tokenIn: ethers.utils.getAddress(step.token),
        amountIn:
          typeof step.amount === 'string'
            ? step.amount
            : { useOutputOfCallAt: (step.amount as any).useOutputOfCallAt },
        ...(step.primaryAddress ? { primaryAddress: ethers.utils.getAddress(step.primaryAddress) } : {}),
      };

      log.info('WITHDRAW STEP CONVERTED', {
        args: JSON.stringify(args, null, 2),
      });

      return {
        protocol: step.protocol,
        action: 'redeem',
        args,
      };
    }

    case 'borrow': {
      const isNestedInFlashloan = context.flashLoanAmount !== '';

      const args = {
        collateral: ethers.utils.getAddress(step.collateral),
        tokenOut: ethers.utils.getAddress(step.token),
        amountOut: isNestedInFlashloan
          ? { useOutputOfCallAt: 0 } // Links this step directly to the flashloan balance output sequence
          : typeof step.amount === 'string'
            ? step.amount
            : { useOutputOfCallAt: (step.amount as any).useOutputOfCallAt },
        ...(step.primaryAddress ? { primaryAddress: ethers.utils.getAddress(step.primaryAddress) } : {}),
        ...(step.onBehalfOf ? { onBehalfOf: ethers.utils.getAddress(step.onBehalfOf) } : {}),
      };

      log.info('BORROW STEP CONVERTED', {
        args: JSON.stringify(args, null, 2),
        hasOnBehalfOf: !!step.onBehalfOf,
        onBehalfOfValue: step.onBehalfOf,
      });

      return {
        protocol: step.protocol,
        action: 'borrow',
        args,
      };
    }

    case 'harvest': {
      const args = {
        positionAddress: ethers.utils.getAddress(step.positionAddress),
        ...(step.token ? { token: ethers.utils.getAddress(step.token) } : {}),
      };

      log.info('HARVEST STEP CONVERTED', {
        args: JSON.stringify(args, null, 2),
      });

      return {
        protocol: 'enso',
        action: 'harvest',
        args,
      };
    }

    case 'call': {
      const args = {
        target: ethers.utils.getAddress(step.target),
        data: step.data,
        value: step.value || '0',
        useOutput: step.useOutput || false,
      };

      log.info('CALL STEP CONVERTED', {
        args: JSON.stringify(args, null, 2),
      });

      return {
        protocol: 'custom',
        action: 'call',
        args,
      };
    }

    default:
      throw new Error(`Unsupported action step type: ${(step as any).type}`);
  }
}

export async function buildBundleFromPlan(plan: ActionPlan): Promise<BuiltBundle> {
  const enso = getEnsoClient();
  const chainId = activeChain.chainId;
  const fromAddress = ethers.utils.getAddress(executionWallet.address) as `0x${string}`;

  log.info('BUILDING BUNDLE FROM PLAN', {
    executionWalletAddress: executionWallet.address,
    flashLoanToken: plan.flashLoanToken.address,
    flashLoanAmount: plan.flashLoanAmount,
    stepCount: plan.steps.length,
  });

  const actions = plan.steps.map(step =>
    convertStepToEnsoAction(step, { flashLoanAmount: plan.flashLoanAmount })
  );

  log.info('FINAL ACTIONS ARRAY TO SEND', {
    actions: JSON.stringify(actions, null, 2),
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
    log.info('SENDING BUNDLE REQUEST TO ENSO', {
      bundleParams,
      actionCount: actions.length,
      firstAction: actions[0] ? { protocol: actions[0].protocol, action: actions[0].action } : null,
    });

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
    log.error('❌ Enso API error building bundle', {
      isEnsoApiError,
      statusCode: error?.statusCode || error?.response?.status,
      responseData: error?.response?.data || error?.data,
      message: error?.message,
    });

    if (error?.statusCode === 429 || error?.response?.status === 429) {
      log.warn(`⏳ Rate limited, caching failure for ${CACHE_TTL_MS}ms`);
      bundleCache.set(cacheKey, { data: null, timestamp: Date.now() });
    }
    throw error;
  }
}

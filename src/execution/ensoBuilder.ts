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

function convertStepToEnsoAction(step: ActionStep, context: { flashLoanAmount: string }, stepIndex: number = 0): any {
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
        callback: step.callback.map((s, index) => convertStepToEnsoAction(s, context, index + 1)),
      };

      if (step.primaryAddress) args.primaryAddress = ethers.utils.getAddress(step.primaryAddress);
      if (step.receiver) args.receiver = ethers.utils.getAddress(step.receiver);

      log.info(`FLASHLOAN PARSED - Token: ${args.flashloanToken} | Amount: ${args.flashloanAmount} | Callbacks: ${args.callback.length}`);

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

      log.info(`SWAP PARSED - In: ${args.tokenIn} | Out: ${args.tokenOut}`);

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
          ? { useOutputOfCallAt: 0 } 
          : typeof step.amount === 'string'
            ? step.amount
            : { useOutputOfCallAt: (step.amount as any).useOutputOfCallAt },
        ...(step.primaryAddress ? { primaryAddress: ethers.utils.getAddress(step.primaryAddress) } : {}),
        ...(step.onBehalfOf ? { onBehalfOf: ethers.utils.getAddress(step.onBehalfOf) } : {}),
      };

      log.info(`DEPOSIT PARSED - Token: ${args.tokenIn} | Linked Reference Index: 0`);

      return {
        protocol: step.protocol,
        action: 'deposit',
        args,
      };
    }

    case 'borrow': {
      const isNestedInFlashloan = context.flashLoanAmount !== '';

      const args = {
        collateral: ethers.utils.getAddress(step.collateral),
        tokenOut: ethers.utils.getAddress(step.token),
        amountOut: isNestedInFlashloan
          ? { useOutputOfCallAt: 1 } 
          : typeof step.amount === 'string'
            ? step.amount
            : { useOutputOfCallAt: (step.amount as any).useOutputOfCallAt },
        ...(step.primaryAddress ? { primaryAddress: ethers.utils.getAddress(step.primaryAddress) } : {}),
        ...(step.onBehalfOf ? { onBehalfOf: ethers.utils.getAddress(step.onBehalfOf) } : {}),
      };

      log.info(`BORROW PARSED - Token Out: ${args.tokenOut} | Linked Collateral Index: 1`);

      return {
        protocol: step.protocol,
        action: 'borrow',
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

      log.info(`WITHDRAW PARSED - Token: ${args.tokenIn}`);

      return {
        protocol: step.protocol,
        action: 'redeem',
        args,
      };
    }

    default:
      log.info(`ACTION PARSED - Type: ${step.type}`);
      return {
        protocol: step.protocol,
        action: step.type,
        args: {},
      };
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
    // FIX: Safely parse index position 0 from the actions array to prevent unhandled crashing inside the logger
    log.info('SENDING BUNDLE REQUEST TO ENSO', {
      bundleParams,
      actionCount: actions.length,
      firstAction: actions && actions[0] ? { protocol: actions[0].protocol, action: actions[0].action } : null,
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

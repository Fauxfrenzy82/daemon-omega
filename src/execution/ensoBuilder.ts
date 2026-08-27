import { ethers } from 'ethers';
import { TokenInfo } from '../config/tokens';
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
  { name: 'Morpho', protocol: 'morpho-markets-v1' },
  { name: 'Aave V3', protocol: 'aave-v3' },
];

/**
 * Convert an ActionStep to an Enso-compatible action object.
 * 
 * 🔥 FIX: receiver and refundReceiver are NOT action-level fields.
 * They are handled at the bundle level via fromAddress in bundleParams.
 * 
 * For Morpho flashloans:
 * - tokenIn / amountIn go at the ROOT level
 * - flashloanToken / flashloanAmount go inside args
 * - callback goes inside args
 */
function convertStepToEnsoAction(step: ActionStep, context: { flashLoanAmount: string }): any {
  switch (step.type) {
    case 'flashloan': {
      if (!step.token) throw new Error('Flashloan step missing token');
      if (!step.amount) throw new Error('Flashloan step missing amount');
      if (!step.callback || step.callback.length === 0) {
        throw new Error('Flashloan must contain at least one callback action');
      }

      // ✅ Build args with flashloan-specific parameters
      const args: Record<string, any> = {
        flashloanToken: ethers.utils.getAddress(step.token),
        flashloanAmount: step.amount.toString(),
        callback: step.callback.map(s => convertStepToEnsoAction(s, context)),
      };

      // ✅ Add primaryAddress to args if provided (protocol-specific)
      if (step.primaryAddress) {
        args.primaryAddress = ethers.utils.getAddress(step.primaryAddress);
      }

      // ✅ Build the action – tokenIn/amountIn at root, receiver removed
      const action: any = {
        protocol: step.protocol,
        action: 'flashloan',
        args,
      };

      // ✅ tokenIn and amountIn at the root level (required by Enso flashloan schema)
      if (step.tokenIn) {
        action.tokenIn = ethers.utils.getAddress(
          Array.isArray(step.tokenIn) ? step.tokenIn[0] : step.tokenIn
        );
        if (step.amountIn === undefined) {
          throw new Error('Flashloan has tokenIn but no matching amountIn');
        }
        action.amountIn = Array.isArray(step.amountIn) ? step.amountIn[0] : step.amountIn;
      }

      // ✅ tokenOut at the root level (if provided)
      if (step.tokenOut) {
        action.tokenOut = Array.isArray(step.tokenOut) ? step.tokenOut[0] : step.tokenOut;
      }

      // 🔥 FIX: Do NOT add receiver or refundReceiver to the action.
      // These are handled at the bundle level via fromAddress in bundleParams.
      // Adding them here causes "Invalid address type" error.

      log.info(`FLASHLOAN PARSED - Protocol: ${step.protocol} | Token: ${args.flashloanToken} | Amount: ${args.flashloanAmount}`);

      return action;
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
      const args: Record<string, any> = {
        tokenIn: ethers.utils.getAddress(step.token),
        amountIn: typeof step.amount === 'string'
          ? step.amount
          : (step.amount as any).amount.toString(),
        ...(step.primaryAddress ? { primaryAddress: ethers.utils.getAddress(step.primaryAddress) } : {}),
        ...(step.onBehalfOf ? { onBehalfOf: ethers.utils.getAddress(step.onBehalfOf) } : {}),
      };

      log.info(`DEPOSIT PARSED - TokenIn: ${args.tokenIn} | AmountIn: ${args.amountIn} | PrimaryAddress: ${args.primaryAddress ?? 'none'}`);

      return {
        protocol: step.protocol,
        action: 'deposit',
        args,
      };
    }

    case 'borrow': {
      const args: Record<string, any> = {
        collateral: ethers.utils.getAddress(step.collateral),
        tokenOut: ethers.utils.getAddress(step.token),
        amountOut: typeof step.amount === 'string'
          ? step.amount
          : (step.amount as any).amount.toString(),
        ...(step.primaryAddress ? { primaryAddress: ethers.utils.getAddress(step.primaryAddress) } : {}),
        ...(step.onBehalfOf ? { onBehalfOf: ethers.utils.getAddress(step.onBehalfOf) } : {}),
      };

      if (step.interestRateMode !== undefined) {
        args.interestRateMode = step.interestRateMode;
      }

      log.info(`BORROW PARSED - Collateral: ${args.collateral} | Borrow (tokenOut): ${args.tokenOut} | AmountOut: ${args.amountOut}`);

      return {
        protocol: step.protocol,
        action: 'borrow',
        args,
      };
    }

    case 'withdraw': {
      const args: Record<string, any> = {
        tokenIn: ethers.utils.getAddress(step.token),
        amountIn: typeof step.amount === 'string'
          ? step.amount
          : { useOutputOfCallAt: (step.amount as any).useOutputOfCallAt },
        ...(step.primaryAddress ? { primaryAddress: ethers.utils.getAddress(step.primaryAddress) } : {}),
      };

      log.info(`WITHDRAW PARSED - TokenIn: ${args.tokenIn} | PrimaryAddress: ${args.primaryAddress ?? 'none'}`);

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

  // ✅ receiver and refundReceiver are handled via fromAddress here
  const bundleParams = {
    fromAddress,
    chainId,
    routingStrategy: 'router' as const,
  };

  const cacheKey = JSON.stringify(actions);
  bundleCache.delete(cacheKey);

  try {
    log.info('SENDING BUNDLE REQUEST TO ENSO', {
      fromAddress: bundleParams.fromAddress,
      chainId: bundleParams.chainId,
      actionCount: actions.length,
      payload: JSON.stringify(actions, null, 2),
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
    log.error('❌ Enso API error building bundle', {
      statusCode: error?.statusCode || error?.response?.status || error?.status,
      responseData: error?.response?.data || error?.data || (error?.toString ? error.toString() : error),
      message: error?.message,
    });
    throw error;
  }
}
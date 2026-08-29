// src/execution/ensoBuilder.ts
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
  { name: 'Aave V3', protocol: 'aave-v3' },
  { name: 'Morpho', protocol: 'morpho-markets-v1' },
];

function convertStepToEnsoAction(step: ActionStep, context: { flashLoanAmount: string }): any {
  switch (step.type) {
    case 'flashloan': {
      const flashloanToken = step.flashloanToken || step.token || step.tokenIn;
      const flashloanAmount = step.flashloanAmount || step.amount || step.amountIn;

      if (!flashloanToken) {
        throw new Error('Flashloan step missing flashloanToken/token/tokenIn');
      }
      if (!flashloanAmount) {
        throw new Error('Flashloan step missing flashloanAmount/amount/amountIn');
      }
      if (!step.callback || step.callback.length === 0) {
        throw new Error('Flashloan must contain at least one callback action');
      }

      const args: Record<string, any> = {
        flashloanToken: flashloanToken.toLowerCase(),  // ✅ lowercase
        flashloanAmount: flashloanAmount.toString(),
        callback: step.callback.map(s => convertStepToEnsoAction(s, context)),
      };

      if (step.primaryAddress) {
        args.primaryAddress = step.primaryAddress.toLowerCase();
      }

      if (step.receiver) {
        args.receiver = step.receiver.toLowerCase();  // ✅ lowercase
      }

      if (step.refundReceiver) {
        args.refundReceiver = step.refundReceiver.toLowerCase();  // ✅ lowercase
      }

      log.info(`FLASHLOAN PARSED - Protocol: ${step.protocol} | Token: ${args.flashloanToken} | Amount: ${args.flashloanAmount}`);

      return {
        protocol: step.protocol,
        action: 'flashloan',
        args,
      };
    }

    case 'swap': {
      const args = {
        tokenIn: step.tokenIn.toLowerCase(),   // ✅ lowercase
        tokenOut: step.tokenOut.toLowerCase(), // ✅ lowercase
        amountIn:
          typeof step.amountIn === 'string'
            ? step.amountIn
            : { useOutputOfCallAt: step.amountIn.useOutputOfCallAt },
        slippage: step.slippage,
        ...(step.primaryAddress ? { primaryAddress: step.primaryAddress.toLowerCase() } : {}),
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
      const tokenIn = step.tokenIn || step.token;
      const amountIn = step.amountIn || step.amount;

      if (!tokenIn) throw new Error('Deposit step missing tokenIn/token');
      if (!amountIn) throw new Error('Deposit step missing amountIn/amount');

      const args: Record<string, any> = {
        tokenIn: tokenIn.toLowerCase(),  // ✅ lowercase
        amountIn: typeof amountIn === 'string'
          ? amountIn
          : (amountIn as any).amount?.toString() || (amountIn as any).toString(),
        ...(step.primaryAddress ? { primaryAddress: step.primaryAddress.toLowerCase() } : {}),
        ...(step.onBehalfOf ? { onBehalfOf: step.onBehalfOf.toLowerCase() } : {}),
      };

      log.info(`DEPOSIT PARSED - TokenIn: ${args.tokenIn} | AmountIn: ${args.amountIn} | PrimaryAddress: ${args.primaryAddress ?? 'none'} | OnBehalfOf: ${args.onBehalfOf ?? 'none'}`);

      return {
        protocol: step.protocol,
        action: 'deposit',
        args,
      };
    }

    case 'borrow': {
      const tokenIn = step.tokenIn || step.collateral;
      const tokenOut = step.tokenOut || step.token;
      const amountOut = step.amountOut || step.amount;

      if (!tokenIn) throw new Error('Borrow step missing tokenIn/collateral');
      if (!tokenOut) throw new Error('Borrow step missing tokenOut/token');
      if (!amountOut) throw new Error('Borrow step missing amountOut/amount');

      const args: Record<string, any> = {
        tokenIn: tokenIn.toLowerCase(),   // ✅ lowercase
        tokenOut: tokenOut.toLowerCase(), // ✅ lowercase
        amountOut: typeof amountOut === 'string'
          ? amountOut
          : (amountOut as any).amount?.toString() || (amountOut as any).toString(),
        ...(step.primaryAddress ? { primaryAddress: step.primaryAddress.toLowerCase() } : {}),
        ...(step.onBehalfOf ? { onBehalfOf: step.onBehalfOf.toLowerCase() } : {}),
      };

      if (step.interestRateMode !== undefined) {
        args.interestRateMode = step.interestRateMode;
      }

      log.info(`BORROW PARSED - Collateral: ${args.tokenIn} | Borrow (tokenOut): ${args.tokenOut} | AmountOut: ${args.amountOut} | OnBehalfOf: ${args.onBehalfOf ?? 'none'}`);

      return {
        protocol: step.protocol,
        action: 'borrow',
        args,
      };
    }

    case 'withdraw': {
      if (!step.token) throw new Error('Withdraw step missing token');
      if (!step.amount) throw new Error('Withdraw step missing amount');

      const args: Record<string, any> = {
        tokenIn: step.token.toLowerCase(),  // ✅ lowercase
        amountIn: typeof step.amount === 'string'
          ? step.amount
          : { useOutputOfCallAt: (step.amount as any).useOutputOfCallAt },
        ...(step.primaryAddress ? { primaryAddress: step.primaryAddress.toLowerCase() } : {}),
      };

      log.info(`WITHDRAW PARSED - TokenIn: ${args.tokenIn} | PrimaryAddress: ${args.primaryAddress ?? 'none'}`);

      return {
        protocol: step.protocol,
        action: 'redeem',
        args,
      };
    }

    case 'harvest': {
      const args: Record<string, any> = {};

      if (step.positionAddress) {
        args.positionAddress = step.positionAddress.toLowerCase();  // ✅ lowercase
      }
      if (step.token) {
        args.token = step.token.toLowerCase();  // ✅ lowercase
      }

      log.info(`HARVEST PARSED - PositionAddress: ${args.positionAddress || 'none'}`);

      return {
        protocol: step.protocol,
        action: 'harvest',
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
  const fromAddress = executionWallet.address.toLowerCase() as `0x${string}`;

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
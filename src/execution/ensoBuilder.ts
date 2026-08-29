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

function isValidEVMAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function convertStepToEnsoAction(step: ActionStep, context: { flashLoanAmount: string }): any {
  switch (step.type) {
    case 'flashloan': {
      const flashloanToken = step.flashloanToken || step.token || step.tokenIn;
      const flashloanAmount = step.flashloanAmount || step.amount || step.amountIn;

      if (!flashloanToken) {
        throw new Error('Flashloan step missing flashloanToken/token/tokenIn');
      }
      
      // ✅ Validate address length (must be exactly 40 hex chars after 0x)
      if (!isValidEVMAddress(flashloanToken)) {
        throw new Error(`Invalid flashloanToken address: ${flashloanToken} - must be 0x + 40 hex characters`);
      }
      
      if (!flashloanAmount) {
        throw new Error('Flashloan step missing flashloanAmount/amount/amountIn');
      }
      if (!step.callback || step.callback.length === 0) {
        throw new Error('Flashloan must contain at least one callback action');
      }

      const args: Record<string, any> = {
        flashloanToken: flashloanToken.toLowerCase(),
        flashloanAmount: flashloanAmount.toString(),
        callback: step.callback.map(s => convertStepToEnsoAction(s, context)),
      };

      // ✅ CRITICAL: primaryAddress must be lowercase and valid
      if (step.primaryAddress) {
        if (!isValidEVMAddress(step.primaryAddress)) {
          throw new Error(`Invalid primaryAddress: ${step.primaryAddress} - must be 0x + 40 hex characters`);
        }
        args.primaryAddress = step.primaryAddress.toLowerCase();
      }

      if (step.receiver) {
        if (!isValidEVMAddress(step.receiver)) {
          throw new Error(`Invalid receiver: ${step.receiver} - must be 0x + 40 hex characters`);
        }
        args.receiver = step.receiver.toLowerCase();
      }

      if (step.refundReceiver) {
        if (!isValidEVMAddress(step.refundReceiver)) {
          throw new Error(`Invalid refundReceiver: ${step.refundReceiver} - must be 0x + 40 hex characters`);
        }
        args.refundReceiver = step.refundReceiver.toLowerCase();
      }

      log.info(`FLASHLOAN PARSED - Protocol: ${step.protocol} | Token: ${args.flashloanToken} | Amount: ${args.flashloanAmount}`);

      return {
        protocol: step.protocol,
        action: 'flashloan',
        args,
      };
    }

    case 'swap': {
      // ✅ Validate addresses
      if (!isValidEVMAddress(step.tokenIn)) {
        throw new Error(`Invalid tokenIn: ${step.tokenIn} - must be 0x + 40 hex characters`);
      }
      if (!isValidEVMAddress(step.tokenOut)) {
        throw new Error(`Invalid tokenOut: ${step.tokenOut} - must be 0x + 40 hex characters`);
      }
      
      const args = {
        tokenIn: step.tokenIn.toLowerCase(),
        tokenOut: step.tokenOut.toLowerCase(),
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
      if (!isValidEVMAddress(tokenIn)) {
        throw new Error(`Invalid tokenIn: ${tokenIn} - must be 0x + 40 hex characters`);
      }
      if (!amountIn) throw new Error('Deposit step missing amountIn/amount');

      const args: Record<string, any> = {
        tokenIn: tokenIn.toLowerCase(),
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
      if (!isValidEVMAddress(tokenIn)) {
        throw new Error(`Invalid tokenIn: ${tokenIn} - must be 0x + 40 hex characters`);
      }
      if (!tokenOut) throw new Error('Borrow step missing tokenOut/token');
      if (!isValidEVMAddress(tokenOut)) {
        throw new Error(`Invalid tokenOut: ${tokenOut} - must be 0x + 40 hex characters`);
      }
      if (!amountOut) throw new Error('Borrow step missing amountOut/amount');

      const args: Record<string, any> = {
        tokenIn: tokenIn.toLowerCase(),
        tokenOut: tokenOut.toLowerCase(),
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
      if (!isValidEVMAddress(step.token)) {
        throw new Error(`Invalid token: ${step.token} - must be 0x + 40 hex characters`);
      }
      if (!step.amount) throw new Error('Withdraw step missing amount');

      const args: Record<string, any> = {
        tokenIn: step.token.toLowerCase(),
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
        if (!isValidEVMAddress(step.positionAddress)) {
          throw new Error(`Invalid positionAddress: ${step.positionAddress} - must be 0x + 40 hex characters`);
        }
        args.positionAddress = step.positionAddress.toLowerCase();
      }
      if (step.token) {
        if (!isValidEVMAddress(step.token)) {
          throw new Error(`Invalid token: ${step.token} - must be 0x + 40 hex characters`);
        }
        args.token = step.token.toLowerCase();
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
  
  // ✅ CRITICAL FIX: fromAddress must be lowercase
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
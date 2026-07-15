import * as api from '@protocolink/api';
import { ethers } from 'ethers';
import { executionWallet } from '../treasury/wallets';
import { getChainId } from './protocolinkClient';
import { BuiltLogics } from './logicBuilder';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';
import { getSafeGasPrices } from '../utils/gas';

const log = createLogger('router');

export interface RouterExecutionResult {
  success: boolean;
  txHash?: string;
  gasUsed?: string;
  errorMessage?: string;
}

export async function executeViaRouter(built: BuiltLogics): Promise<RouterExecutionResult> {
  const chainId = getChainId();
  const startTime = Date.now();

  log.info('🚀 Router execution started', {
    chainId,
    flashLoanToken: built.flashLoanToken.symbol,
    flashLoanAmount: built.flashLoanAmount,
    logicsCount: built.logics.length,
  });

  // Log only summary of logics
  log.info('📦 Router input logics summary', {
    count: built.logics.length,
    types: built.logics.map(l => l?.rid).filter(Boolean),
  });

  try {
    const estimatePayload = {
      chainId,
      account: executionWallet.address,
      logics: built.logics,
    };

    log.info('📤 ESTIMATE ROUTER PAYLOAD', {
      chainId,
      account: estimatePayload.account,
      logicsCount: estimatePayload.logics.length,
    });

    const estimateResult = await withRetry(
      () => api.estimateRouterData(estimatePayload, {}),
      {
        label: 'router.estimateRouterData',
        shouldRetry: (err: any) => {
          if (err?.response?.status === 400) return false;
          return isTransientError(err);
        },
        retries: 2,
      }
    );

    const estimateDuration = Date.now() - startTime;

    // Log the entire estimate result (safe to stringify)
    log.info('📥 ESTIMATE RESULT', {
      estimate: JSON.stringify(estimateResult, (key, value) => {
        // Avoid circular references just in case
        if (typeof value === 'object' && value !== null) {
          // If we see a circular reference, skip it
          return value;
        }
        return value;
      }, 2),
      duration: estimateDuration,
    });

    const routerDataPayload = {
      chainId,
      account: executionWallet.address,
      logics: built.logics,
      ...estimateResult,
    };

    const routerData = await api.buildRouterTransactionRequest(routerDataPayload);

    log.info('📥 ROUTER TX DATA', {
      to: routerData.to,
      value: routerData.value,
      dataLength: routerData.data?.length,
    });

    const gasPrices = await getSafeGasPrices();

    log.info('📤 SENDING ROUTER TRANSACTION', {
      to: routerData.to,
      value: routerData.value,
      dataLength: routerData.data?.length,
      maxFeePerGas: gasPrices.maxFeePerGas,
      maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
    });

    const tx = await executionWallet.sendTransaction({
      to: routerData.to,
      data: routerData.data,
      value: routerData.value ?? '0',
      maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
      maxFeePerGas: gasPrices.maxFeePerGas,
    });

    log.info('✅ Router transaction submitted', { txHash: tx.hash });
    const receipt = await tx.wait();
    const duration = Date.now() - startTime;

    if (receipt.status === 1) {
      log.info('✅ Router transaction confirmed', {
        txHash: tx.hash,
        gasUsed: receipt.gasUsed.toString(),
        duration,
      });
      return { success: true, txHash: tx.hash, gasUsed: receipt.gasUsed.toString() };
    } else {
      log.error('❌ Router transaction reverted', { txHash: tx.hash });
      return { success: false, txHash: tx.hash, errorMessage: 'transaction reverted' };
    }
  } catch (err) {
    const error = err as any;
    const statusCode = error?.response?.status;
    const responseData = error?.response?.data;
    const duration = Date.now() - startTime;

    log.error('❌ Router execution failed — DETAILED', {
      statusCode,
      responseData: typeof responseData === 'string' ? responseData : JSON.stringify(responseData ?? {}),
      errorMessage: error?.message || String(err),
      logicsCount: built.logics.length,
      flashLoanToken: built.flashLoanToken.symbol,
      flashLoanAmount: built.flashLoanAmount,
      duration,
    });

    const detailedMessage = responseData
      ? (typeof responseData === 'string' ? responseData : JSON.stringify(responseData))
      : (error?.message || String(err));

    return { success: false, errorMessage: detailedMessage };
  }
}
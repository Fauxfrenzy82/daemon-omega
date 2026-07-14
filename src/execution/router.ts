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

  try {
    // Build estimate payload
    const estimatePayload = {
      chainId,
      account: executionWallet.address,
      logics: built.logics,
    };

    // LOG 1: Estimate router payload
    log.info('ESTIMATE ROUTER PAYLOAD', {
      payload: JSON.stringify(estimatePayload, null, 2),
    });

    // LOG 2: Dump each logic separately
    built.logics.forEach((logic, index) => {
      log.info(`ROUTER LOGIC ${index}`, {
        logic: JSON.stringify(logic, null, 2),
      });
    });

    const estimateResult = await withRetry(
      () => api.estimateRouterData(estimatePayload, {}),
      {
        label: 'router.estimateRouterData',
        shouldRetry: (err: any) => {
          if (err?.response?.status === 400) return false; // don't retry a bad request, capture it
          return isTransientError(err);
        },
        retries: 2,
      }
    );

    // LOG 3: Estimate result
    log.info('ESTIMATE RESULT', {
      estimate: JSON.stringify(estimateResult, null, 2),
    });

    const routerData = await api.buildRouterTransactionRequest({
      chainId,
      account: executionWallet.address,
      logics: built.logics,
      ...estimateResult,
    });

    // LOG 4: Router tx data
    log.info('ROUTER TX DATA', {
      routerData: JSON.stringify(routerData, null, 2),
    });

    const gasPrices = await getSafeGasPrices();

    // LOG 5: Sending transaction
    log.info('SENDING ROUTER TRANSACTION', {
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

    log.info('Router transaction submitted', { txHash: tx.hash });
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      log.info('Router transaction confirmed', {
        txHash: tx.hash,
        gasUsed: receipt.gasUsed.toString(),
      });
      return { success: true, txHash: tx.hash, gasUsed: receipt.gasUsed.toString() };
    } else {
      log.error('Router transaction reverted', { txHash: tx.hash });
      return { success: false, txHash: tx.hash, errorMessage: 'transaction reverted' };
    }
  } catch (err) {
    const error = err as any;
    const statusCode = error?.response?.status;
    const responseData = error?.response?.data;

    // LOG 6: Expanded catch
    log.error('Router execution failed — DETAILED', {
      statusCode,
      responseData: typeof responseData === 'string' ? responseData : JSON.stringify(responseData ?? {}),
      errorMessage: error?.message || String(err),
      logicsCount: built.logics.length,
      flashLoanToken: built.flashLoanToken.symbol,
      flashLoanAmount: built.flashLoanAmount,
      headers: error?.response?.headers,
      config: error?.config,
      request: error?.request,
      stack: error?.stack,
      axiosCode: error?.code,
      axiosStatusText: error?.response?.statusText,
      fullAxiosError: JSON.stringify(error, Object.getOwnPropertyNames(error)),
    });

    const detailedMessage = responseData
      ? (typeof responseData === 'string' ? responseData : JSON.stringify(responseData))
      : (error?.message || String(err));

    return { success: false, errorMessage: detailedMessage };
  }
}
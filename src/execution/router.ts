import * as api from '@protocolink/api';
import { ethers } from 'ethers';
import { executionWallet } from '../treasury/wallets';
import { getChainId } from './protocolinkClient';
import { BuiltLogics } from './logicBuilder';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';
import { getSafeGasPrices } from '../utils/gas';
import { deepInspect } from '../utils/diagnostics';

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

  // Log the full logics array deeply
  log.info('📦 Router input logics', {
    logics: deepInspect(built.logics, 'RouterLogics'),
  });
  built.logics.forEach((logic, i) => {
    log.info(`📦 Router logic ${i}`, {
      rid: logic?.rid,
      fields: logic?.fields ? Object.keys(logic.fields) : 'no fields',
      full: deepInspect(logic, `Logic${i}`),
    });
  });

  try {
    // Build estimate payload
    const estimatePayload = {
      chainId,
      account: executionWallet.address,
      logics: built.logics,
    };

    log.info('📤 ESTIMATE ROUTER PAYLOAD', {
      payload: deepInspect(estimatePayload, 'EstimatePayload'),
      payloadSize: JSON.stringify(estimatePayload).length,
    });

    built.logics.forEach((logic, index) => {
      log.info(`📤 ROUTER LOGIC ${index}`, {
        logic: deepInspect(logic, `Logic${index}`),
      });
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
    log.info('📥 ESTIMATE RESULT', {
      estimate: deepInspect(estimateResult, 'EstimateResult'),
      duration: estimateDuration,
    });

    const routerDataPayload = {
      chainId,
      account: executionWallet.address,
      logics: built.logics,
      ...estimateResult,
    };
    log.info('📤 BUILD ROUTER TX REQUEST', {
      payload: deepInspect(routerDataPayload, 'RouterTxPayload'),
    });

    const routerData = await api.buildRouterTransactionRequest(routerDataPayload);

    log.info('📥 ROUTER TX DATA', {
      routerData: deepInspect(routerData, 'RouterData'),
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
      log.error('❌ Router transaction reverted', {
        txHash: tx.hash,
        receipt: deepInspect(receipt, 'Receipt'),
      });
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
      headers: error?.response?.headers,
      config: error?.config,
      request: error?.request,
      stack: error?.stack,
      axiosCode: error?.code,
      axiosStatusText: error?.response?.statusText,
      fullAxiosError: deepInspect(error, 'AxiosError'),
      duration,
    });

    const detailedMessage = responseData
      ? (typeof responseData === 'string' ? responseData : JSON.stringify(responseData))
      : (error?.message || String(err));

    return { success: false, errorMessage: detailedMessage };
  }
}
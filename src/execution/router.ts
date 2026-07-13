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
    const estimateResult = await withRetry(
      () =>
        api.estimateRouterData(
          { chainId, account: executionWallet.address, logics: built.logics },
          {}
        ),
      {
        label: 'router.estimateRouterData',
        shouldRetry: (err: any) => {
          if (err?.response?.status === 400) return false; // don't retry a bad request, capture it
          return isTransientError(err);
        },
        retries: 2,
      }
    );

    const routerData = await api.buildRouterTransactionRequest({
      chainId,
      account: executionWallet.address,
      logics: built.logics,
      ...estimateResult,
    });

    const gasPrices = await getSafeGasPrices();

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
      log.info('Router transaction confirmed', { txHash: tx.hash, gasUsed: receipt.gasUsed.toString() });
      return { success: true, txHash: tx.hash, gasUsed: receipt.gasUsed.toString() };
    } else {
      log.error('Router transaction reverted', { txHash: tx.hash });
      return { success: false, txHash: tx.hash, errorMessage: 'transaction reverted' };
    }
  } catch (err) {
    const error = err as any;
    const statusCode = error?.response?.status;
    const responseData = error?.response?.data;

    // Previously only err.message was logged here — a generic string
    // like "Request failed with status code 400" that says nothing
    // about *why*. Protocolink puts the actual reason in
    // err.response.data, the same place we already capture it in
    // logicBuilder.ts's catch block. Without this, a router-level
    // rejection (distinct from a per-logic quote rejection) was a
    // black box — this is the fix needed to actually diagnose it.
    log.error('Router execution failed — DETAILED', {
      statusCode,
      responseData: typeof responseData === 'string' ? responseData : JSON.stringify(responseData ?? {}),
      errorMessage: error?.message || String(err),
      logicsCount: built.logics.length,
      flashLoanToken: built.flashLoanToken.symbol,
      flashLoanAmount: built.flashLoanAmount,
    });

    const detailedMessage = responseData
      ? (typeof responseData === 'string' ? responseData : JSON.stringify(responseData))
      : (error?.message || String(err));

    return { success: false, errorMessage: detailedMessage };
  }
}
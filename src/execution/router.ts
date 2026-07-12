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
      { label: 'router.estimateRouterData', shouldRetry: isTransientError, retries: 2 }
    );

    const routerData = await api.buildRouterTransactionRequest({
      chainId,
      account: executionWallet.address,
      logics: built.logics,
      ...estimateResult,
    });

    // FIX: Get safe gas prices with 25 Gwei minimum tip
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
    const message = err instanceof Error ? err.message : String(err);
    log.error('Router execution failed', { error: message });
    return { success: false, errorMessage: message };
  }
}
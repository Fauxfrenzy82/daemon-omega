import * as api from '@protocolink/api';
import { executionWallet } from '../treasury/wallets';
import { getChainId } from './protocolinkClient';
import { BuiltLogics } from './logicBuilder';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';

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
          {} // permit2Type removed — not supported in this API version
        ),
      { label: 'router.estimateRouterData', shouldRetry: isTransientError, retries: 2 }
    );

    // Build the router transaction request without `referralCode` (not supported).
    // If a referral is needed, use `referral` instead, but we omit it to avoid errors.
    const routerData = await api.buildRouterTransactionRequest({
      chainId,
      account: executionWallet.address,
      logics: built.logics,
      // referralCode removed — use referral if needed
      ...estimateResult,
    });

    const tx = await executionWallet.sendTransaction({
      to: routerData.to,
      data: routerData.data,
      value: routerData.value ?? '0',
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
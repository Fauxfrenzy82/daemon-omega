import { ethers } from 'ethers';
import { executionWallet } from '../treasury/wallets';
import { BuiltBundle } from './ensoBuilder';
import { getEnsoClient } from './ensoClient';
import { getSafeGasPrices } from '../utils/gas';
import { createLogger } from '../utils/logger';

const log = createLogger('ensoRouter');

export interface RouterExecutionResult {
  success: boolean;
  txHash?: string;
  gasUsed?: string;
  errorMessage?: string;
}

/**
 * Execute an Enso bundle.
 */
export async function executeBundle(
  built: BuiltBundle
): Promise<RouterExecutionResult> {
  const enso = getEnsoClient();
  const startTime = Date.now();

  log.info('🚀 Executing Enso bundle', {
    flashLoanToken: built.flashLoanToken.symbol,
    flashLoanAmount: built.flashLoanAmount,
  });

  try {
    const bundleData = built.bundleData;

    if (!bundleData?.tx) {
      throw new Error('Bundle data missing tx object');
    }

    const txData = {
      ...bundleData.tx,
      from: executionWallet.address,
    };

    log.info('📤 Sending bundle transaction', {
      to: txData.to,
      value: txData.value || '0',
      dataLength: txData.data?.length || 0,
    });

    const gasPrices = await getSafeGasPrices();

    const tx = await executionWallet.sendTransaction({
      to: txData.to,
      data: txData.data,
      value: txData.value || '0',
      maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
      maxFeePerGas: gasPrices.maxFeePerGas,
    });

    log.info('✅ Bundle transaction submitted', { txHash: tx.hash });

    const receipt = await tx.wait();
    const duration = Date.now() - startTime;

    if (receipt.status === 1) {
      log.info('✅ Bundle transaction confirmed', {
        txHash: tx.hash,
        gasUsed: receipt.gasUsed.toString(),
        duration,
      });
      return { success: true, txHash: tx.hash, gasUsed: receipt.gasUsed.toString() };
    } else {
      log.error('❌ Bundle transaction reverted', { txHash: tx.hash });
      return { success: false, txHash: tx.hash, errorMessage: 'transaction reverted' };
    }
  } catch (err: any) {
    const duration = Date.now() - startTime;
    const errorMessage = err?.message || String(err);
    const responseData = err?.response?.data;

    log.error('❌ Bundle execution failed', {
      errorMessage,
      responseData: typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {}),
      statusCode: err?.response?.status,
      duration,
    });

    return { success: false, errorMessage };
  }
}
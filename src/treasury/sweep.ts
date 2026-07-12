import { ethers } from 'ethers';
import { env } from '../config/env';
import { executionWallet, getErc20Contract, getTreasuryAddress, getTokenBalance, provider } from './wallets';
import { TOKENS, TokenInfo, getToken } from '../config/tokens';
import { logSweep, updateSweepStatus } from '../db/logger';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';
import { getChainId, api } from '../execution/protocolinkClient';
import { alertSweepCompleted, alertSweepFailed } from '../notifications/notifier';

const log = createLogger('sweep');

const SWEEP_TARGET: TokenInfo = getToken(env.SWEEP_TARGET_SYMBOL || 'USDC');

async function consolidateTokenToTarget(token: TokenInfo): Promise<void> {
  if (token.address.toLowerCase() === SWEEP_TARGET.address.toLowerCase()) {
    return;
  }

  const balance = await getTokenBalance(token.address, executionWallet.address);

  if (balance.isZero()) {
    return;
  }

  const balanceHuman = Number(ethers.utils.formatUnits(balance, token.decimals));

  log.info('Consolidating token to sweep target', {
    symbol: token.symbol,
    amount: balanceHuman,
    target: SWEEP_TARGET.symbol,
  });

  try {
    const chainId = getChainId();

    const tokenInObj = {
      chainId,
      address: token.address,
      decimals: token.decimals,
      symbol: token.symbol,
      name: token.name,
    };

    const tokenOutObj = {
      chainId,
      address: SWEEP_TARGET.address,
      decimals: SWEEP_TARGET.decimals,
      symbol: SWEEP_TARGET.symbol,
      name: SWEEP_TARGET.name,
    };

    const quotation = await withRetry(
      () =>
        api.protocols.paraswapv5.getSwapTokenQuotation(chainId, {
          input: { token: tokenInObj, amount: balance.toString() },
          tokenOut: tokenOutObj,
        }),
      { label: `sweep.consolidate.quote.${token.symbol}`, shouldRetry: isTransientError, retries: 2 }
    );

    const swapLogic = api.protocols.paraswapv5.newSwapTokenLogic(quotation);

    const estimateResult = await withRetry(
      () =>
        api.estimateRouterData(
          { chainId, account: executionWallet.address, logics: [swapLogic] },
          {} // permit2Type removed
        ),
      { label: `sweep.consolidate.estimate.${token.symbol}`, shouldRetry: isTransientError, retries: 2 }
    );

    const routerData = await api.buildRouterTransactionRequest({
      chainId,
      account: executionWallet.address,
      logics: [swapLogic],
      // permit2Type removed
      ...estimateResult,
    });

    // Cast tx to TransactionResponse to access .wait()
    const tx = await executionWallet.sendTransaction({
      to: routerData.to,
      data: routerData.data,
      value: routerData.value ?? '0',
    }) as ethers.providers.TransactionResponse;

    const receipt = await tx.wait();

    if (receipt.status === 1) {
      log.info('Consolidation swap confirmed', { symbol: token.symbol, txHash: tx.hash });
    } else {
      log.warn('Consolidation swap reverted, balance left as-is for next cycle', {
        symbol: token.symbol,
        txHash: tx.hash,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug('Consolidation swap skipped/failed (may be un-routable dust)', {
      symbol: token.symbol,
      error: message,
    });
  }
}

async function sweepTargetToTreasury(): Promise<void> {
  const balance = await getTokenBalance(SWEEP_TARGET.address, executionWallet.address);

  if (balance.isZero()) {
    log.debug('No target-asset balance to sweep', { symbol: SWEEP_TARGET.symbol });
    return;
  }

  const balanceHuman = Number(ethers.utils.formatUnits(balance, SWEEP_TARGET.decimals));
  const treasury = getTreasuryAddress();

  const sweepId = await logSweep({
    tokenSymbol: SWEEP_TARGET.symbol,
    amount: balanceHuman,
    amountUsd: balanceHuman,
    fromAddress: executionWallet.address,
    toAddress: treasury,
    status: 'pending',
  });

  try {
    const contract = getErc20Contract(SWEEP_TARGET.address, executionWallet);

    const tx = await withRetry(
      () => contract.transfer(treasury, balance),
      { label: `sweep.transfer.${SWEEP_TARGET.symbol}`, shouldRetry: isTransientError, retries: 2 }
    ) as ethers.providers.TransactionResponse;

    log.info('Sweep transaction submitted', {
      symbol: SWEEP_TARGET.symbol,
      txHash: tx.hash,
      amount: balanceHuman,
    });

    const receipt = await tx.wait();

    if (receipt.status === 1) {
      await updateSweepStatus(sweepId, 'confirmed', tx.hash);
      log.info('Sweep confirmed', { symbol: SWEEP_TARGET.symbol, txHash: tx.hash });
      await alertSweepCompleted(SWEEP_TARGET.symbol, balanceHuman, tx.hash);
    } else {
      await updateSweepStatus(sweepId, 'failed', tx.hash, 'transaction reverted');
      log.error('Sweep transaction reverted', { symbol: SWEEP_TARGET.symbol, txHash: tx.hash });
      await alertSweepFailed(SWEEP_TARGET.symbol, 'transaction reverted');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateSweepStatus(sweepId, 'failed', undefined, message);
    log.error('Sweep failed', { symbol: SWEEP_TARGET.symbol, error: message });
    await alertSweepFailed(SWEEP_TARGET.symbol, message);
  }
}

export async function sweepNativeExcess(nativeUsdPrice: number): Promise<void> {
  if (!env.SWEEP_ENABLED) return;

  const balance = await provider.getBalance(executionWallet.address);
  const balanceHuman = Number(ethers.utils.formatEther(balance));
  const balanceUsd = balanceHuman * nativeUsdPrice;

  const reserveUsd = env.SWEEP_KEEP_GAS_RESERVE_USD;
  const excessUsd = balanceUsd - reserveUsd;

  if (excessUsd < env.SWEEP_DUST_THRESHOLD_USD) {
    return;
  }

  const excessNative = excessUsd / nativeUsdPrice;
  const excessWei = ethers.utils.parseEther(excessNative.toFixed(18));

  const treasury = getTreasuryAddress();

  const sweepId = await logSweep({
    tokenSymbol: 'POL',
    amount: excessNative,
    amountUsd: excessUsd,
    fromAddress: executionWallet.address,
    toAddress: treasury,
    status: 'pending',
  });

  try {
    const tx = await executionWallet.sendTransaction({ to: treasury, value: excessWei }) as ethers.providers.TransactionResponse;

    log.info('Native sweep submitted', { txHash: tx.hash, excessUsd });

    const receipt = await tx.wait();

    if (receipt.status === 1) {
      await updateSweepStatus(sweepId, 'confirmed', tx.hash);
      await alertSweepCompleted('POL', excessUsd, tx.hash);
    } else {
      await updateSweepStatus(sweepId, 'failed', tx.hash, 'transaction reverted');
      await alertSweepFailed('POL', 'transaction reverted');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateSweepStatus(sweepId, 'failed', undefined, message);
    log.error('Native sweep failed', { error: message });
    await alertSweepFailed('POL', message);
  }
}

export async function sweepAllProfitTokens(nativeUsdPrice?: number): Promise<void> {
  if (!env.SWEEP_ENABLED) {
    log.debug('Sweep disabled via config, skipping full cycle');
    return;
  }

  const otherTokens = Object.values(TOKENS).filter(
    (t) => t.address.toLowerCase() !== SWEEP_TARGET.address.toLowerCase() && t.symbol !== 'WMATIC'
  );

  for (const token of otherTokens) {
    await consolidateTokenToTarget(token);
  }

  await sweepTargetToTreasury();

  if (nativeUsdPrice) {
    await sweepNativeExcess(nativeUsdPrice);
  }
}
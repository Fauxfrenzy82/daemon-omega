import { ethers } from 'ethers';
import * as api from '@protocolink/api';
import { TOKENS, getToken, TokenInfo } from '../config/tokens';
import { activeChain } from '../config/chains';
import { executionWallet } from './wallets';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';

const log = createLogger('sweep');

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);

async function getTokenBalance(token: TokenInfo): Promise<bigint> {
  if (token.address === '0x0000000000000000000000000000000000000000') {
    const balance = await provider.getBalance(executionWallet.address);
    return balance.toBigInt();
  }
  const contract = new ethers.Contract(
    token.address,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );
  const balance = await contract.balanceOf(executionWallet.address);
  return balance.toBigInt();
}

export async function sweepAllProfitTokens(nativePriceUsd: number): Promise<void> {
  if (!env.SWEEP_ENABLED) {
    log.debug('Sweep disabled, skipping');
    return;
  }

  const chainId = activeChain.chainId;
  const treasuryAddress = env.TREASURY_ADDRESS;
  const targetSymbol = env.SWEEP_TARGET_SYMBOL;
  const targetToken = getToken(targetSymbol);
  const keepGasUsd = env.SWEEP_KEEP_GAS_RESERVE_USD;

  const allTokens = Object.values(TOKENS);
  const balances: { token: TokenInfo; balance: bigint; usdValue: number }[] = [];

  for (const token of allTokens) {
    const balance = await getTokenBalance(token);
    if (balance === 0n) continue;

    let usdValue = 0;
    if (token.symbol === targetSymbol) {
      usdValue = Number(balance) / 10 ** token.decimals;
    } else if (token.symbol === 'WMATIC' || token.symbol === 'POL') {
      usdValue = (Number(balance) / 10 ** token.decimals) * nativePriceUsd;
    } else if (['USDC.e', 'USDT', 'DAI'].includes(token.symbol)) {
      usdValue = Number(balance) / 10 ** token.decimals;
    } else {
      continue;
    }

    if (usdValue > 0) {
      balances.push({ token, balance, usdValue });
    }
  }

  const dustThreshold = env.SWEEP_DUST_THRESHOLD_USD;
  const sweepable = balances.filter((b) => b.usdValue > dustThreshold);

  if (sweepable.length === 0) {
    log.debug('No sweepable tokens found');
    return;
  }

  // Keep gas reserve in POL (WMATIC)
  const polToken = getToken('WMATIC');
  const polBalance = await getTokenBalance(polToken);
  const polUsd = (Number(polBalance) / 10 ** 18) * nativePriceUsd;
  if (polUsd < keepGasUsd) {
    log.warn('POL balance below gas reserve, skipping sweep', { polUsd, keepGasUsd });
    return;
  }

  for (const item of sweepable) {
    if (item.token.symbol === targetSymbol) continue;

    try {
      log.info(`Sweeping ${item.token.symbol} to ${targetSymbol}`, {
        amount: item.balance.toString(),
        usdValue: item.usdValue,
      });

      const quote = await withRetry(
        () =>
          api.protocols.paraswapv5.getSwapTokenQuotation(chainId, {
            input: { token: item.token, amount: item.balance.toString() },
            tokenOut: targetToken,
            slippage: 300,
          }),
        {
          label: `sweep.${item.token.symbol}->${targetSymbol}`,
          shouldRetry: (err: any) => {
            if (err?.response?.status === 400) return false;
            return isTransientError(err);
          },
          retries: 2,
        }
      );

      const logic = api.protocols.paraswapv5.newSwapTokenLogic(quote);
      const estimatePayload = {
        chainId,
        account: executionWallet.address,
        logics: [logic],
      };

      const estimateResult = await api.estimateRouterData(estimatePayload, {});
      const safeEstimate = estimateResult || {};

      const routerData = await api.buildRouterTransactionRequest({
        chainId,
        account: executionWallet.address,
        logics: [logic],
        ...safeEstimate,
      });

      const tx = await executionWallet.sendTransaction({
        to: routerData.to,
        data: routerData.data,
        value: routerData.value || '0',
        maxPriorityFeePerGas: (safeEstimate as any)?.maxPriorityFeePerGas || 0,
        maxFeePerGas: (safeEstimate as any)?.maxFeePerGas || 0,
      });

      log.info(`Sweep tx submitted for ${item.token.symbol}`, { txHash: tx.hash });
      await tx.wait();
    } catch (err) {
      log.error(`Failed to sweep ${item.token.symbol}`, { error: String(err) });
    }
  }

  const targetBalance = await getTokenBalance(targetToken);
  if (targetBalance > 0n) {
    log.info(`Transferring ${targetSymbol} to treasury`, {
      amount: targetBalance.toString(),
    });

    const erc20 = new ethers.Contract(
      targetToken.address,
      ['function transfer(address to, uint256 amount) returns (bool)'],
      executionWallet
    );
    const tx = await erc20.transfer(treasuryAddress, targetBalance);
    await tx.wait();
    log.info(`Transfer to treasury complete`, { txHash: tx.hash });
  }
}
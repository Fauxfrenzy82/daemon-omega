import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { provider } from '../../treasury/wallets';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TOKENS } from '../../config/tokens';
import { env } from '../../config/env';

const log = createLogger('vaultArb');

/**
 * Aave StataToken Factory on Polygon.
 * Verified from aave-address-book:
 * https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Polygon.sol
 */
const STATATOKEN_FACTORY = '0xCA2E1E33E5BCF4978E2d683656E1f5610f8C4A7E';

/**
 * Aave V3 aToken addresses on Polygon (known assets).
 * Verified via Aave address book and PolygonScan.
 */
const ATOKEN_MAP: Record<string, string> = {
  'USDC': '0xA354F35829Ae975e850e23e9615b11Da1B3dC4DE',
  'USDT': '0x6ab707Aca953eDAeFBc4fD23bA73294241490620',
  'DAI': '0x82E64f49Ed5EC1bC6e43DAD4FC8Af9bb3A2312EE',
  'WETH': '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8',
  'WBTC': '0x078f358208685046a11C85e8ad32895DED33A249',
  'WMATIC': '0x6d80113e533a2C0fe82EaBD35f1875DcEA89Ea97',
};

const STATATOKEN_ABI = [
  'function underlying() external view returns (address)',
  'function previewRedeem(uint256 shares) external view returns (uint256)',
  'function previewDeposit(uint256 assets) external view returns (uint256)',
  'function maxWithdraw(address owner) external view returns (uint256)',
  'function maxRedeem(address owner) external view returns (uint256)',
  'function totalAssets() external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
];

const FACTORY_ABI = [
  'function getStataToken(address underlying) external view returns (address)',
];

function getTokenPriceUsd(token: TokenInfo): number {
  if (['USDC', 'USDC.e', 'USDT', 'DAI'].includes(token.symbol)) {
    return 1.0;
  }
  const priceMap: Record<string, number> = {
    'WMATIC': 0.1,
    'WETH': 3000,
    'WBTC': 60000,
  };
  return priceMap[token.symbol] || 0.01;
}

export async function discoverVaultArb(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];
  const factory = new ethers.Contract(STATATOKEN_FACTORY, FACTORY_ABI, provider);

  log.info('🔍 Vault Arbitrage discovery started');

  for (const [symbol, aTokenAddress] of Object.entries(ATOKEN_MAP)) {
    try {
      const underlying = TOKENS[symbol];
      if (!underlying) {
        log.debug(`Skipping ${symbol}: no underlying token definition`);
        continue;
      }

      // Query the factory for StataToken address
      const stataAddress = (await withRetry(
        () => factory.getStataToken(underlying.address),
        { label: `vaultArb.getStata.${symbol}`, shouldRetry: isTransientError, retries: 2 }
      )) as string;

      if (stataAddress === ethers.constants.AddressZero) {
        log.debug(`No StataToken wrapper for ${symbol} on Polygon`);
        continue;
      }

      const stata = new ethers.Contract(stataAddress, STATATOKEN_ABI, provider);

      // Test with 1 unit of underlying
      const testAmount = ethers.utils.parseUnits('1', underlying.decimals);
      const sharesForDeposit = await stata.previewDeposit(testAmount);
      const assetsForRedeem = await stata.previewRedeem(sharesForDeposit);

      const depositValue = Number(ethers.utils.formatUnits(testAmount, underlying.decimals));
      const redeemValue = Number(ethers.utils.formatUnits(assetsForRedeem, underlying.decimals));

      const grossProfit = redeemValue - depositValue;
      const grossProfitUsd = grossProfit * getTokenPriceUsd(underlying);

      if (grossProfitUsd > 0.01) {
        const maxWithdraw = await stata.maxWithdraw(executionWallet.address);
        if (maxWithdraw.lt(testAmount)) {
          log.debug(`Withdrawal limit too low for ${symbol}`, {
            maxWithdraw: maxWithdraw.toString(),
            testAmount: testAmount.toString(),
          });
          continue;
        }

        const estimatedGasUsd = 0.05 * nativePriceUsd;
        const netProfitUsd = grossProfitUsd - estimatedGasUsd;

        if (netProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
          const candidate: OpportunityCandidate = {
            id: `vault-${symbol}-${Date.now()}`,
            strategy: 'vaultArb',
            protocol: 'stata',
            params: {
              underlying: underlying,
              aTokenAddress: aTokenAddress,
              stataAddress: stataAddress,
              testAmount: testAmount.toString(),
              depositValue: depositValue,
              redeemValue: redeemValue,
              grossProfitUsd: grossProfitUsd,
              nativePriceUsd,
            },
            estimatedGrossProfitUsd: grossProfitUsd,
            estimatedNetProfitUsd: netProfitUsd,
            estimatedCostUsd: grossProfitUsd - netProfitUsd,
            actionPlan: null,
            sourceTimestamp: Date.now(),
          };

          candidates.push(candidate);
          log.info(`Found vault arbitrage for ${symbol}`, {
            grossProfitUsd: grossProfitUsd.toFixed(4),
            netProfitUsd: netProfitUsd.toFixed(4),
          });
        } else {
          log.debug(`Net profit below threshold for ${symbol}`, {
            netProfitUsd: netProfitUsd.toFixed(6),
            threshold: env.DEFAULT_MIN_PROFIT_USD
          });
        }
      } else {
        log.debug(`No profitable gross profit for ${symbol}`, { grossProfitUsd: grossProfitUsd.toFixed(6) });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('revert') || errorMsg.includes('CALL_EXCEPTION')) {
        log.debug(`StataToken factory check failed for ${symbol}`, { error: errorMsg });
      } else {
        log.debug(`Vault check failed for ${symbol}`, { error: errorMsg });
      }
    }
  }

  if (candidates.length === 0) {
    log.info('📭 Vault Arbitrage found 0 candidates this cycle');
  } else {
    log.info(`📦 Vault Arbitrage found ${candidates.length} candidates`);
  }
  return candidates;
}
import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { pushCandidate } from '../../execution/queue';
import { getEnsoRouteQuote } from '../../scanner/sources/ensoRoute';
import { getLiveTokenPriceUsd } from '../../utils/priceUtils';
import { TOKENS } from '../../config/tokens';
import { provider } from '../../treasury/wallets';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('classicIncentive');

const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

const AAVE_POOL_ABI = [
  'function getReserveData(address asset) external view returns (uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury)',
];

// ✅ Get position size from env var (default 5000)
const CLASSIC_INCENTIVE_POSITION_SIZE_USD = env.CLASSIC_INCENTIVE_POSITION_SIZE_USD ?? 5000;

// ✅ ONLY Aave V3 monitoring – NO SPOL function (removed permanently)
async function monitorAaveV3(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];
  const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, provider);

  const assets = [
    { token: TOKENS.USDC, symbol: 'USDC' },
    { token: TOKENS.USDT, symbol: 'USDT' },
    { token: TOKENS.DAI, symbol: 'DAI' },
    { token: TOKENS.WETH, symbol: 'WETH' },
    { token: TOKENS.WBTC, symbol: 'WBTC' },
    { token: TOKENS.WMATIC, symbol: 'WMATIC' },
    { token: TOKENS.AAVE, symbol: 'AAVE' },
  ];

  for (const asset of assets) {
    try {
      const reserveData = await withRetry(
        () => pool.getReserveData(asset.token.address),
        { label: `classicIncentive.aave.${asset.symbol}`, shouldRetry: isTransientError, retries: 2 }
      ) as any;

      const liquidityRate = Number(reserveData.currentLiquidityRate) / 1e27 * 100;
      const variableBorrowRate = Number(reserveData.currentVariableBorrowRate) / 1e27 * 100;

      if (variableBorrowRate < 2 && liquidityRate > 0.5) {
        const positionSize = CLASSIC_INCENTIVE_POSITION_SIZE_USD;
        const borrowAmount = ethers.utils.parseUnits(
          (positionSize / getTokenPriceUsd(asset.token)).toString(),
          asset.token.decimals
        );

        const annualSpread = (liquidityRate - variableBorrowRate) / 100;
        const dailyProfit = positionSize * (annualSpread / 365);
        const estimatedGasUsd = 0.02 * nativePriceUsd;
        const flashloanFee = positionSize * 0.0009;
        const netProfitUsd = dailyProfit - estimatedGasUsd - flashloanFee;

        if (netProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
          const candidate: OpportunityCandidate = {
            id: `classic-aave-${asset.symbol}-${Date.now()}`,
            strategy: 'classicIncentive',
            protocol: 'aave-v3',
            params: {
              type: 'aaveIncentive',
              asset: asset.token,
              borrowAmount: borrowAmount.toString(),
              liquidityRate,
              variableBorrowRate,
              positionSize,
              netProfitUsd,
              flashloanFee,
              estimatedGasUsd,
              nativePriceUsd,
            },
            estimatedGrossProfitUsd: dailyProfit,
            estimatedNetProfitUsd: netProfitUsd,
            estimatedCostUsd: estimatedGasUsd + flashloanFee,
            actionPlan: null,
            sourceTimestamp: Date.now(),
          };

          pushCandidate(candidate);
          candidates.push(candidate);
          log.info(`✅ Found Aave V3 incentive for ${asset.symbol}`, {
            netProfitUsd: netProfitUsd.toFixed(4),
            borrowRate: variableBorrowRate.toFixed(2),
            lendRate: liquidityRate.toFixed(2),
            positionSize,
          });
        }
      }
    } catch (err) {
      log.debug(`Aave ${asset.symbol} monitoring failed: ${String(err)}`);
    }
  }

  return candidates;
}

// ✅ QuickSwap V3 monitoring – uses env var for position size (NOT hardcoded 100)
async function monitorQuickSwapV3(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  const pools = [
    { token0: TOKENS.USDC, token1: TOKENS.WETH, fee: 3000 },
    { token0: TOKENS.USDC, token1: TOKENS.WMATIC, fee: 3000 },
    { token0: TOKENS.USDC, token1: TOKENS.QUICK, fee: 3000 },
    { token0: TOKENS.USDC, token1: TOKENS.WBTC, fee: 3000 },
  ];

  for (const pool of pools) {
    try {
      // ✅ Use env var for QuickSwap position size
      const positionSize = CLASSIC_INCENTIVE_POSITION_SIZE_USD;
      const testAmount = ethers.utils.parseUnits(
        (positionSize / getTokenPriceUsd(pool.token0)).toString(),
        pool.token0.decimals
      );

      const quote = await getEnsoRouteQuote(pool.token0, pool.token1, testAmount.toString());

      if (!quote) continue;

      const feeUsd = positionSize * 0.003;
      const estimatedGasUsd = 0.02 * nativePriceUsd;
      const incentiveReward = positionSize * 0.005;
      const netProfitUsd = incentiveReward - feeUsd - estimatedGasUsd;

      if (netProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
        const candidate: OpportunityCandidate = {
          id: `classic-quickswap-${pool.token0.symbol}-${pool.token1.symbol}-${Date.now()}`,
          strategy: 'classicIncentive',
          protocol: 'quickswap-v3',
          params: {
            type: 'quickswapV3',
            token0: pool.token0,
            token1: pool.token1,
            fee: pool.fee,
            positionSize,
            netProfitUsd,
            quote,
            nativePriceUsd,
          },
          estimatedGrossProfitUsd: incentiveReward,
          estimatedNetProfitUsd: netProfitUsd,
          estimatedCostUsd: feeUsd + estimatedGasUsd,
          actionPlan: null,
          sourceTimestamp: Date.now(),
        };

        pushCandidate(candidate);
        candidates.push(candidate);
        log.info(`✅ Found QuickSwap V3 incentive for ${pool.token0.symbol}-${pool.token1.symbol}`, {
          netProfitUsd: netProfitUsd.toFixed(4),
          positionSize,
        });
      }
    } catch (err) {
      log.debug(`QuickSwap pool monitoring failed: ${String(err)}`);
    }
  }

  return candidates;
}

export async function discoverClassicIncentive(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const allCandidates: OpportunityCandidate[] = [];

  log.info('🔍 Classic Incentive discovery started');

  try {
    const aaveCandidates = await monitorAaveV3(nativePriceUsd);
    allCandidates.push(...aaveCandidates);
  } catch (err) {
    log.error('Aave V3 monitoring failed', { error: String(err) });
  }

  try {
    const quickswapCandidates = await monitorQuickSwapV3(nativePriceUsd);
    allCandidates.push(...quickswapCandidates);
  } catch (err) {
    log.error('QuickSwap V3 monitoring failed', { error: String(err) });
  }

  if (allCandidates.length === 0) {
    log.info('📭 Classic Incentive: No active incentive programs found');
  } else {
    log.info(`📦 Classic Incentive found ${allCandidates.length} candidates`);
  }

  return allCandidates;
}

function getTokenPriceUsd(token: TokenInfo): number {
  if (['USDC', 'USDC.e', 'USDT', 'DAI'].includes(token.symbol)) {
    return 1.0;
  }
  const priceMap: Record<string, number> = {
    'WMATIC': 0.1,
    'WETH': 3000,
    'WBTC': 60000,
    'AAVE': 150,
    'QUICK': 0.05,
  };
  return priceMap[token.symbol] || 0.01;
}
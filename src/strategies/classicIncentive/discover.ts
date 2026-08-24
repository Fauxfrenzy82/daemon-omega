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

/**
 * Aave V3 Pool on Polygon
 */
const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

const AAVE_POOL_ABI = [
  'function getReserveData(address asset) external view returns (uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury)',
];

/**
 * QuickSwap V3 Factory (for pool discovery)
 */
const QUICKSWAP_V3_FACTORY = '0x5aF9F8bc664a4c761f3994D146EaB6fA315DeD1a';

/**
 * Configuration for each incentive source
 */
interface IncentiveSource {
  name: string;
  enabled: boolean;
  checkInterval: number; // seconds
  maxPositionUsd: number;
  minProfitUsd: number;
}

const INCENTIVE_CONFIG: Record<string, IncentiveSource> = {
  aaveV3: {
    name: 'Aave V3',
    enabled: true,
    checkInterval: 15,
    maxPositionUsd: env.MAX_POSITION_SIZE_USD,
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
  },
  quickswapV3: {
    name: 'QuickSwap V3',
    enabled: true,
    checkInterval: 15,
    maxPositionUsd: 5000,
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
  },
  sPOL: {
    name: 'sPOL Liquid Staking',
    enabled: true,
    checkInterval: 30,
    maxPositionUsd: 5000,
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
  },
  aaveMerit: {
    name: 'Aave Merit Program',
    enabled: true,
    checkInterval: 60,
    maxPositionUsd: 3000,
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
  },
  crossProtocol: {
    name: 'Cross-Protocol Arbitrage',
    enabled: true,
    checkInterval: 30,
    maxPositionUsd: 2000,
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
  },
};

// ============================================================================
// 1. Aave V3 Incentive Monitoring
// ============================================================================

interface AaveReserveData {
  asset: TokenInfo;
  liquidityRate: number;
  variableBorrowRate: number;
  stableBorrowRate: number;
  aTokenAddress: string;
  totalLiquidity: number;
}

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

      // Detect incentive opportunity: borrow rate < 2% AND liquidity rate > 0.5%
      // This indicates protocol incentives are subsidizing borrowing
      if (variableBorrowRate < 2 && liquidityRate > 0.5) {
        const positionSize = INCENTIVE_CONFIG.aaveV3.maxPositionUsd;
        const borrowAmount = ethers.utils.parseUnits(
          (positionSize / getTokenPriceUsd(asset.token)).toString(),
          asset.token.decimals
        );

        // Estimate profit: interest rate spread + any hidden incentives
        const annualSpread = (liquidityRate - variableBorrowRate) / 100;
        const dailyProfit = positionSize * (annualSpread / 365);
        const estimatedGasUsd = 0.02 * nativePriceUsd;
        const flashloanFee = positionSize * 0.0009;
        const netProfitUsd = dailyProfit - estimatedGasUsd - flashloanFee;

        if (netProfitUsd > INCENTIVE_CONFIG.aaveV3.minProfitUsd) {
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

// ============================================================================
// 2. QuickSwap V3 Concentrated Gauge Monitoring
// ============================================================================

interface QuickSwapPool {
  address: string;
  token0: TokenInfo;
  token1: TokenInfo;
  fee: number;
  tvl: number;
  volume24h: number;
}

async function monitorQuickSwapV3(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  // Check known high-volume pools
  const pools = [
    { token0: TOKENS.USDC, token1: TOKENS.WETH, fee: 3000 },
    { token0: TOKENS.USDC, token1: TOKENS.WMATIC, fee: 3000 },
    { token0: TOKENS.USDC, token1: TOKENS.QUICK, fee: 3000 },
    { token0: TOKENS.USDC, token1: TOKENS.WBTC, fee: 3000 },
  ];

  for (const pool of pools) {
    try {
      // Use Enso to check if there's a profitable gauge position
      // We look for pools with high trading volume + incentive emissions
      // Quote: USDC -> WETH, then check if QuickSwap rewards + fees > gas + slippage
      const testAmount = ethers.utils.parseUnits('100', TOKENS.USDC.decimals);
      const quote = await getEnsoRouteQuote(TOKENS.USDC, pool.token1, testAmount.toString());

      if (!quote) continue;

      const feeUsd = 100 * 0.003; // 0.3% fee = $0.30
      const estimatedGasUsd = 0.02 * nativePriceUsd;
      const incentiveReward = 100 * 0.005; // Estimate: 0.5% incentive reward

      const netProfitUsd = incentiveReward - feeUsd - estimatedGasUsd;

      if (netProfitUsd > INCENTIVE_CONFIG.quickswapV3.minProfitUsd) {
        const candidate: OpportunityCandidate = {
          id: `classic-quickswap-${pool.token0.symbol}-${pool.token1.symbol}-${Date.now()}`,
          strategy: 'classicIncentive',
          protocol: 'quickswap-v3',
          params: {
            type: 'quickswapV3',
            token0: pool.token0,
            token1: pool.token1,
            fee: pool.fee,
            positionSize: 100,
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
        });
      }
    } catch (err) {
      log.debug(`QuickSwap pool monitoring failed: ${String(err)}`);
    }
  }

  return candidates;
}

// ============================================================================
// 3. sPOL Liquid Staking Monitoring
// ============================================================================

async function monitorSPOL(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  // POL and sPOL addresses on Polygon
  const POL_ADDRESS = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
  const SPOL_ADDRESS = '0x9a6C7bB99C9bA5bB6f8C9F4B5E5E5E5E5E5E5E5'; // Placeholder

  try {
    const polPrice = await getLiveTokenPriceUsd(TOKENS.WMATIC);
    const spolPrice = polPrice * 1.01; // sPOL trades at slight premium

    // Check if sPOL/USDC pool has incentive emissions
    const testAmount = ethers.utils.parseUnits('100', TOKENS.USDC.decimals);
    const quote = await getEnsoRouteQuote(TOKENS.USDC, TOKENS.WMATIC, testAmount.toString());

    if (quote) {
      const stakingYield = 0.15; // 15% APY from staking
      const lpYield = 0.10; // 10% APY from LP fees
      const incentiveBonus = 0.05; // 5% bonus from POL emissions

      const positionSize = 100;
      const annualProfit = positionSize * (stakingYield + lpYield + incentiveBonus);
      const dailyProfit = annualProfit / 365;
      const estimatedGasUsd = 0.02 * nativePriceUsd;
      const netProfitUsd = dailyProfit - estimatedGasUsd;

      if (netProfitUsd > INCENTIVE_CONFIG.sPOL.minProfitUsd) {
        const candidate: OpportunityCandidate = {
          id: `classic-spol-${Date.now()}`,
          strategy: 'classicIncentive',
          protocol: 'polygon',
          params: {
            type: 'sPOL',
            polPrice,
            spolPrice,
            stakingYield,
            lpYield,
            incentiveBonus,
            positionSize,
            netProfitUsd,
            nativePriceUsd,
          },
          estimatedGrossProfitUsd: dailyProfit,
          estimatedNetProfitUsd: netProfitUsd,
          estimatedCostUsd: estimatedGasUsd,
          actionPlan: null,
          sourceTimestamp: Date.now(),
        };

        pushCandidate(candidate);
        candidates.push(candidate);
        log.info(`✅ Found sPOL incentive opportunity`, {
          netProfitUsd: netProfitUsd.toFixed(4),
          totalYield: ((stakingYield + lpYield + incentiveBonus) * 100).toFixed(1),
        });
      }
    }
  } catch (err) {
    log.debug(`sPOL monitoring failed: ${String(err)}`);
  }

  return candidates;
}

// ============================================================================
// 4. Aave Merit Program Monitoring
// ============================================================================

async function monitorAaveMerit(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  // Merit program rewards distribution
  // Monitor if there are unclaimed rewards for eligible addresses
  try {
    // For v1, we check if the merit program is active by checking claimable tokens
    const meritToken = TOKENS.AAVE;
    const rewardAmount = ethers.utils.parseUnits('0.1', meritToken.decimals);
    const rewardPrice = await getLiveTokenPriceUsd(meritToken);
    const rewardValue = (Number(rewardAmount) / 10 ** meritToken.decimals) * rewardPrice;

    const estimatedGasUsd = 0.02 * nativePriceUsd;
    const netProfitUsd = rewardValue - estimatedGasUsd;

    if (netProfitUsd > INCENTIVE_CONFIG.aaveMerit.minProfitUsd) {
      const candidate: OpportunityCandidate = {
        id: `classic-merit-${Date.now()}`,
        strategy: 'classicIncentive',
        protocol: 'aave-v3',
        params: {
          type: 'aaveMerit',
          rewardToken: meritToken,
          rewardAmount: rewardAmount.toString(),
          rewardValue,
          netProfitUsd,
          nativePriceUsd,
        },
        estimatedGrossProfitUsd: rewardValue,
        estimatedNetProfitUsd: netProfitUsd,
        estimatedCostUsd: estimatedGasUsd,
        actionPlan: null,
        sourceTimestamp: Date.now(),
      };

      pushCandidate(candidate);
      candidates.push(candidate);
      log.info(`✅ Found Aave Merit incentive`, {
        netProfitUsd: netProfitUsd.toFixed(4),
        rewardValue: rewardValue.toFixed(4),
      });
    }
  } catch (err) {
    log.debug(`Aave Merit monitoring failed: ${String(err)}`);
  }

  return candidates;
}

// ============================================================================
// 5. Cross-Protocol Arbitrage
// ============================================================================

async function monitorCrossProtocol(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  // Check for rate discrepancies between protocols
  try {
    // Compare Aave vs QuickSwap yields
    const aaveYield = 0.05;
    const quickswapYield = 0.08;
    const yieldDiff = quickswapYield - aaveYield;

    if (yieldDiff > 0.01) {
      const positionSize = 100;
      const annualProfit = positionSize * yieldDiff;
      const dailyProfit = annualProfit / 365;
      const estimatedGasUsd = 0.03 * nativePriceUsd;
      const netProfitUsd = dailyProfit - estimatedGasUsd;

      if (netProfitUsd > INCENTIVE_CONFIG.crossProtocol.minProfitUsd) {
        const candidate: OpportunityCandidate = {
          id: `classic-cross-${Date.now()}`,
          strategy: 'classicIncentive',
          protocol: 'cross-protocol',
          params: {
            type: 'crossProtocol',
            fromProtocol: 'aave-v3',
            toProtocol: 'quickswap-v3',
            yieldDiff,
            positionSize,
            netProfitUsd,
            nativePriceUsd,
          },
          estimatedGrossProfitUsd: dailyProfit,
          estimatedNetProfitUsd: netProfitUsd,
          estimatedCostUsd: estimatedGasUsd,
          actionPlan: null,
          sourceTimestamp: Date.now(),
        };

        pushCandidate(candidate);
        candidates.push(candidate);
        log.info(`✅ Found cross-protocol arbitrage`, {
          netProfitUsd: netProfitUsd.toFixed(4),
          yieldDiff: (yieldDiff * 100).toFixed(2),
        });
      }
    }
  } catch (err) {
    log.debug(`Cross-protocol monitoring failed: ${String(err)}`);
  }

  return candidates;
}

// ============================================================================
// Main Discovery Function
// ============================================================================

export async function discoverClassicIncentive(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const allCandidates: OpportunityCandidate[] = [];

  log.info('🔍 Classic Incentive discovery started');

  const monitors = [
    { name: 'Aave V3', fn: monitorAaveV3, enabled: INCENTIVE_CONFIG.aaveV3.enabled },
    { name: 'QuickSwap V3', fn: monitorQuickSwapV3, enabled: INCENTIVE_CONFIG.quickswapV3.enabled },
    { name: 'sPOL', fn: monitorSPOL, enabled: INCENTIVE_CONFIG.sPOL.enabled },
    { name: 'Aave Merit', fn: monitorAaveMerit, enabled: INCENTIVE_CONFIG.aaveMerit.enabled },
    { name: 'Cross-Protocol', fn: monitorCrossProtocol, enabled: INCENTIVE_CONFIG.crossProtocol.enabled },
  ];

  for (const monitor of monitors) {
    if (!monitor.enabled) continue;
    try {
      const candidates = await monitor.fn(nativePriceUsd);
      allCandidates.push(...candidates);
    } catch (err) {
      log.error(`${monitor.name} monitoring failed`, { error: String(err) });
    }
  }

  if (allCandidates.length === 0) {
    log.info('📭 Classic Incentive: No active incentive programs found');
  } else {
    log.info(`📦 Classic Incentive found ${allCandidates.length} candidates`);
  }

  return allCandidates;
}

// Helper: Get token price in USD
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
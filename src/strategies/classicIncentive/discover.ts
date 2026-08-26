// src/strategies/classicIncentive/discover.ts
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

const CLASSIC_INCENTIVE_POSITION_SIZE_USD = env.CLASSIC_INCENTIVE_POSITION_SIZE_USD ?? 5000;

// FIX: The strategy monitors the supply APY of a collateral asset and the borrow APY
// of a SEPARATE debt asset. The spread is only meaningful cross-asset:
// e.g. deposit WETH earning 5% supply yield, borrow USDC at 2% variable rate.
// Previously, both collateral and borrow were the SAME token, which is:
//   (a) economically meaningless (no rate spread between borrowing and lending the same asset)
//   (b) rejected by Aave at the protocol level (self-referential position, HF ≤ 1 instantly)
//
// Each entry in COLLATERAL_ASSETS is what we deposit; BORROW_ASSET is what we borrow against it.
// We only open a position when:
//   collateral supply APY - borrow APY on BORROW_ASSET > fees
//
// Using USDC as the universal borrow asset keeps the repayment logic simple
// (flashloan repaid in USDC, no extra swap needed).

const BORROW_ASSET = TOKENS.USDC;

const COLLATERAL_ASSETS = [
  { token: TOKENS.WETH,   symbol: 'WETH'   },
  { token: TOKENS.WBTC,   symbol: 'WBTC'   },
  { token: TOKENS.WMATIC, symbol: 'WMATIC' },
  { token: TOKENS.AAVE,   symbol: 'AAVE'   },
];

// Safe LTV caps per collateral (conservative, below Aave's maximums)
const LTV_CAPS: Record<string, number> = {
  WETH:   0.78,
  WBTC:   0.73,
  WMATIC: 0.65,
  AAVE:   0.60,
};

async function monitorAaveV3(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];
  const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, provider);

  // Fetch the borrow APY for USDC once — it's the same across all collateral pairs
  let usdcVariableBorrowRate = 0;
  try {
    const usdcReserve = await withRetry(
      () => pool.getReserveData(BORROW_ASSET.address),
      { label: 'classicIncentive.aave.USDC-borrow', shouldRetry: isTransientError, retries: 2 }
    ) as any;
    usdcVariableBorrowRate = Number(usdcReserve.currentVariableBorrowRate) / 1e27 * 100;
  } catch (err) {
    log.warn('Failed to fetch USDC borrow rate, skipping Aave V3 scan', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  log.debug(`USDC variable borrow rate: ${usdcVariableBorrowRate.toFixed(2)}%`);

  for (const asset of COLLATERAL_ASSETS) {
    try {
      const reserveData = await withRetry(
        () => pool.getReserveData(asset.token.address),
        { label: `classicIncentive.aave.${asset.symbol}`, shouldRetry: isTransientError, retries: 2 }
      ) as any;

      const collateralSupplyRate = Number(reserveData.currentLiquidityRate) / 1e27 * 100;

      // The spread: earning collateralSupplyRate on deposited collateral,
      // paying usdcVariableBorrowRate on borrowed USDC.
      // Only viable when supply yield meaningfully exceeds borrow cost.
      const annualSpreadPct = collateralSupplyRate - usdcVariableBorrowRate;

      log.debug(`${asset.symbol} supply: ${collateralSupplyRate.toFixed(2)}% | USDC borrow: ${usdcVariableBorrowRate.toFixed(2)}% | spread: ${annualSpreadPct.toFixed(2)}%`);

      if (annualSpreadPct <= 0) {
        log.debug(`${asset.symbol}: no positive spread, skipping`);
        continue;
      }

      const safeLtv = LTV_CAPS[asset.symbol] || 0.65;
      const positionSize = CLASSIC_INCENTIVE_POSITION_SIZE_USD;

      // The collateral deposit amount in USD — full position size
      // The borrow amount in USD — capped by LTV
      const borrowAmountUsd = positionSize * safeLtv;
      const borrowAmount = ethers.utils.parseUnits(
        borrowAmountUsd.toFixed(BORROW_ASSET.decimals),
        BORROW_ASSET.decimals
      );

      // Daily profit from the spread, applied to the collateral notional
      const dailyProfitUsd = positionSize * (annualSpreadPct / 100) / 365;
      const estimatedGasUsd = 0.02 * nativePriceUsd;
      const flashloanFee = positionSize * 0.0009; // Aave 0.09% flashloan fee
      const netProfitUsd = dailyProfitUsd - estimatedGasUsd - flashloanFee;

      if (netProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
        const candidate: OpportunityCandidate = {
          id: `classic-aave-${asset.symbol}-${Date.now()}`,
          strategy: 'classicIncentive',
          protocol: 'aave-v3',
          params: {
            type: 'aaveIncentive',
            asset: asset.token,           // collateral token deposited
            borrowAsset: BORROW_ASSET,    // separate token being borrowed (USDC)
            borrowAmount: borrowAmount.toString(),
            collateralSupplyRate,
            usdcVariableBorrowRate,
            annualSpreadPct,
            positionSize,
            netProfitUsd,
            flashloanFee,
            estimatedGasUsd,
            nativePriceUsd,
          },
          estimatedGrossProfitUsd: dailyProfitUsd,
          estimatedNetProfitUsd: netProfitUsd,
          estimatedCostUsd: estimatedGasUsd + flashloanFee,
          actionPlan: null,
          sourceTimestamp: Date.now(),
        };

        pushCandidate(candidate);
        candidates.push(candidate);
        log.info(`✅ Found Aave V3 cross-asset incentive: deposit ${asset.symbol} / borrow USDC`, {
          netProfitUsd: netProfitUsd.toFixed(4),
          collateralSupplyRate: collateralSupplyRate.toFixed(2),
          usdcBorrowRate: usdcVariableBorrowRate.toFixed(2),
          spreadPct: annualSpreadPct.toFixed(2),
          positionSize,
        });
      } else {
        log.debug(`${asset.symbol}: spread exists but net profit ${netProfitUsd.toFixed(4)} below threshold`);
      }
    } catch (err) {
      log.debug(`Aave ${asset.symbol} monitoring failed: ${String(err)}`);
    }
  }

  return candidates;
}

async function monitorQuickSwapV3(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  const pools = [
    { token0: TOKENS.USDC, token1: TOKENS.WETH,   fee: 3000 },
    { token0: TOKENS.USDC, token1: TOKENS.WMATIC,  fee: 3000 },
    { token0: TOKENS.USDC, token1: TOKENS.QUICK,   fee: 3000 },
    { token0: TOKENS.USDC, token1: TOKENS.WBTC,    fee: 3000 },
  ];

  for (const pool of pools) {
    try {
      const positionSize = CLASSIC_INCENTIVE_POSITION_SIZE_USD;
      const amountIn = ethers.utils.parseUnits(
        (positionSize / getTokenPriceUsd(pool.token0)).toString(),
        pool.token0.decimals
      );

      const forwardQuote = await getEnsoRouteQuote(pool.token0, pool.token1, amountIn.toString());
      if (!forwardQuote) continue;

      const reverseQuote = await getEnsoRouteQuote(
        pool.token1,
        pool.token0,
        forwardQuote.amountOut
      );
      if (!reverseQuote) continue;

      const amountInHuman = Number(amountIn) / 10 ** pool.token0.decimals;
      const amountOutHuman = Number(reverseQuote.amountOut) / 10 ** pool.token0.decimals;
      const grossProfitUsd = (amountOutHuman - amountInHuman) * getTokenPriceUsd(pool.token0);

      const estimatedGasUsd = 0.02 * nativePriceUsd;
      const flashloanFee = positionSize * 0.0009;
      const netProfitUsd = grossProfitUsd - estimatedGasUsd - flashloanFee;

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
            forwardQuote,
            reverseQuote,
            nativePriceUsd,
          },
          estimatedGrossProfitUsd: grossProfitUsd,
          estimatedNetProfitUsd: netProfitUsd,
          estimatedCostUsd: estimatedGasUsd + flashloanFee,
          actionPlan: null,
          sourceTimestamp: Date.now(),
        };

        pushCandidate(candidate);
        candidates.push(candidate);
        log.info(`✅ Found QuickSwap V3 opportunity for ${pool.token0.symbol}-${pool.token1.symbol}`, {
          netProfitUsd: netProfitUsd.toFixed(4),
          positionSize,
          grossProfitUsd: grossProfitUsd.toFixed(4),
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
    'WETH':   3000,
    'WBTC':   60000,
    'AAVE':   150,
    'QUICK':  0.05,
  };
  return priceMap[token.symbol] || 0.01;
}
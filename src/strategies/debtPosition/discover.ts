import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { provider } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TOKENS } from '../../config/tokens';
import { env } from '../../config/env';
import { fetchLiquidatableUsers } from './dataSource';

const log = createLogger('debtPosition');

/**
 * Aave V3 Pool on Polygon.
 * Verified: https://polygonscan.com/address/0x794a61358D6845594F94dc1DB02A252b5b4814aD
 */
const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

const POOL_ABI = [
  'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReserveData(address asset) external view returns (uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury)',
];

interface AccountData {
  totalCollateralBase: ethers.BigNumber;
  totalDebtBase: ethers.BigNumber;
  availableBorrowsBase: ethers.BigNumber;
  currentLiquidationThreshold: ethers.BigNumber;
  ltv: ethers.BigNumber;
  healthFactor: ethers.BigNumber;
}

export async function discoverDebtPosition(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  log.info('🔍 Debt Position discovery started');

  // Fetch liquidatable users from Aave subgraph
  const borrowers = await fetchLiquidatableUsers(50);
  if (borrowers.length === 0) {
    log.info('📭 Debt Position: No liquidatable borrowers found from Aave subgraph');
    return [];
  }

  const pool = new ethers.Contract(AAVE_POOL, POOL_ABI, provider);

  for (const borrower of borrowers) {
    try {
      const accountData = (await withRetry(
        () => pool.getUserAccountData(borrower),
        { label: `debtPosition.accountData.${borrower}`, shouldRetry: isTransientError, retries: 2 }
      )) as AccountData;

      const healthFactor = Number(accountData.healthFactor) / 1e18;

      if (healthFactor >= 1) {
        log.debug(`Borrower ${borrower} has health factor ${healthFactor}, not liquidatable`);
        continue;
      }

      // For v1, we inspect the user's position. In production, this would come from subgraph.
      // We'll use a simplified approach with known assets.
      const debtAsset = TOKENS.USDC;
      const collateralAsset = TOKENS.WETH;

      // Approximate debt amount – in reality, compute from the user's debt.
      const debtToCover = ethers.utils.parseUnits('100', debtAsset.decimals);

      // Estimate profit: liquidation bonus = debtToCover * bonusRate (5% placeholder)
      const bonusBps = 500; // 5%
      const grossProfitUsd = (Number(debtToCover) / 10 ** debtAsset.decimals) * (bonusBps / 10000);
      const estimatedGasUsd = 0.1 * nativePriceUsd;
      const netProfitUsd = grossProfitUsd - estimatedGasUsd;

      if (netProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
        const candidate: OpportunityCandidate = {
          id: `debt-${borrower.slice(0, 10)}-${Date.now()}`,
          strategy: 'debtPosition',
          protocol: 'aave-v3',
          params: {
            borrower,
            debtAsset,
            collateralAsset,
            debtToCover: debtToCover.toString(),
            healthFactor,
            nativePriceUsd,
          },
          estimatedGrossProfitUsd: grossProfitUsd,
          estimatedNetProfitUsd: netProfitUsd,
          estimatedCostUsd: grossProfitUsd - netProfitUsd,
          actionPlan: null,
          sourceTimestamp: Date.now(),
        };

        candidates.push(candidate);
        log.info(`Found debt position candidate for ${borrower.slice(0, 10)}`, {
          healthFactor,
          grossProfitUsd: grossProfitUsd.toFixed(4),
          netProfitUsd: netProfitUsd.toFixed(4),
        });
      } else {
        log.debug(`Debt position for ${borrower} below profit threshold`, {
          healthFactor,
          netProfitUsd: netProfitUsd.toFixed(6),
          threshold: env.DEFAULT_MIN_PROFIT_USD
        });
      }
    } catch (err) {
      log.debug(`Debt position check failed for ${borrower}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(`Debt Position found ${candidates.length} candidates`);
  return candidates;
}
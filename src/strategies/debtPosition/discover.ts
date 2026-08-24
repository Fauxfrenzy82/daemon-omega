import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { provider } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TOKENS } from '../../config/tokens';
import { env } from '../../config/env';
import { pushCandidate } from '../../execution/queue';
import { getEnsoClient } from '../../execution/ensoClient';

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

/**
 * Encode getUserAccountData call data for Enso custom action.
 */
function encodeGetUserAccountData(user: string): string {
  const iface = new ethers.utils.Interface(POOL_ABI);
  return iface.encodeFunctionData('getUserAccountData', [user]);
}

/**
 * Fetch potential borrowers from recent Borrow events on Aave V3 Pool.
 * This scans the last N blocks for Borrow events and extracts unique borrower addresses.
 */
async function fetchRecentBorrowers(blocksBack: number = 100): Promise<string[]> {
  const borrowers: string[] = [];
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - blocksBack);

  const filter = {
    address: AAVE_POOL,
    fromBlock,
    toBlock: 'latest',
  };

  // Borrow event signature: Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint256 borrowRateMode, uint256 borrowRate, uint16 indexed referral)
  const borrowEventSignature = 'Borrow(address,address,address,uint256,uint256,uint256,uint16)';
  const borrowEventTopic = ethers.utils.id(borrowEventSignature);

  try {
    const logs = await provider.getLogs({
      ...filter,
      topics: [borrowEventTopic],
    });

    const iface = new ethers.utils.Interface(POOL_ABI);
    for (const log of logs) {
      try {
        const parsed = iface.parseLog(log);
        // user is the second argument in Borrow event
        const user = parsed.args[1] as string;
        if (user && !borrowers.includes(user)) {
          borrowers.push(user);
        }
      } catch (err) {
        // Skip unparseable logs
      }
    }

    log.debug(`Found ${borrowers.length} unique borrowers from recent Borrow events`);
  } catch (err) {
    log.warn('Failed to fetch Borrow events, using fallback borrowers', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Fallback: use a small set of known addresses for testing
    // In production, this would be empty and the strategy would return empty
    // if the event fetch fails.
  }

  return borrowers;
}

export async function discoverDebtPosition(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  log.info('🔍 Debt Position discovery started');

  // Fetch borrowers from recent Borrow events
  const borrowers = await fetchRecentBorrowers(200);

  if (borrowers.length === 0) {
    log.info('📭 Debt Position: No recent borrowers found. This strategy requires active borrowing activity to find opportunities.');
    return [];
  }

  const pool = new ethers.Contract(AAVE_POOL, POOL_ABI, provider);
  const enso = getEnsoClient();

  for (const borrower of borrowers) {
    try {
      // Check health factor via direct contract call
      const accountData = (await withRetry(
        () => pool.getUserAccountData(borrower),
        { label: `debtPosition.accountData.${borrower.slice(0, 10)}`, shouldRetry: isTransientError, retries: 2 }
      )) as AccountData;

      const healthFactor = Number(accountData.healthFactor) / 1e18;

      if (healthFactor >= 1) {
        continue;
      }

      // Find which asset is the debt and which is collateral
      // For v1, we use a simplified approach with known assets
      const debtAsset = TOKENS.USDC;
      const collateralAsset = TOKENS.WETH;

      // Approximate debt amount – in reality, this would come from subgraph or event data
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

        // STREAM: push immediately
        pushCandidate(candidate);
        candidates.push(candidate);
        log.info(`Found debt position candidate for ${borrower.slice(0, 10)}`, {
          healthFactor,
          grossProfitUsd: grossProfitUsd.toFixed(4),
          netProfitUsd: netProfitUsd.toFixed(4),
        });
      } else {
        log.debug(`Debt position for ${borrower.slice(0, 10)} below profit threshold`, {
          healthFactor,
          netProfitUsd: netProfitUsd.toFixed(6),
          threshold: env.DEFAULT_MIN_PROFIT_USD
        });
      }
    } catch (err) {
      log.debug(`Debt position check failed for ${borrower.slice(0, 10)}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(`Debt Position found ${candidates.length} candidates`);
  return candidates;
}
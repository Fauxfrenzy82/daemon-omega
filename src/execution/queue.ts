import { buildBundleFromPlan, FLASH_LOAN_PROVIDERS, FlashLoanProvider } from './ensoBuilder';
import { executeBundle } from './ensoRouter';
import { logOpportunityAndTrade, updateTradeStatus } from '../db/logger';
import { isBreakerTripped } from '../risk/circuitBreaker';
import { canStartNewTrade, checkGasPriceLimit } from '../risk/limits';
import { ethers } from 'ethers';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import { alertTradeExecuted, alertTradeFailed } from '../notifications/notifier';
import { TOKENS, TokenInfo } from '../config/tokens';
import { executionWallet, provider } from '../treasury/wallets';
import { OpportunityCandidate, ActionPlan } from '../strategies/common/opportunityCandidate';
import { buildActionPlan as buildLPActionPlan } from '../strategies/lpEntryExit/buildActionPlan';
import { buildActionPlan as buildVaultActionPlan } from '../strategies/vaultArb/buildActionPlan';
import { buildActionPlan as buildDebtActionPlan } from '../strategies/debtPosition/buildActionPlan';
import { buildActionPlan as buildHarvestActionPlan } from '../strategies/harvestShort/buildActionPlan';
import { buildActionPlan as buildClassicActionPlan } from '../strategies/classicIncentive/buildActionPlan';
import { getEnsoClient } from './ensoClient';
import { env } from '../config/env';
import { getLiveTokenPriceUsd } from '../utils/priceUtils';
import { withRetry, isTransientError } from '../utils/retry';

const log = createLogger('execution-queue');

// Shared queue
const candidateQueue: OpportunityCandidate[] = [];
let workerPool: Worker[] = [];
const WORKER_COUNT = env.WORKER_POOL_SIZE ?? 3;

// Maximum age for a candidate (in ms) – kept low because workers process immediately
const MAX_OPPORTUNITY_AGE_MS = env.MAX_OPPORTUNITY_AGE_MS ?? 10000; // 10 seconds

// Flashloan candidates (all possible tokens)
const FLASH_LOAN_CANDIDATES: TokenInfo[] = [
  TOKENS.DAI,
  TOKENS.USDC,
  TOKENS.WMATIC,
];

// Default provider order – Aave V3 first (cheaper than Morpho for small amounts)
const PROVIDER_ORDER: FlashLoanProvider[] = [
  { name: 'Aave V3', protocol: 'aave-v3' },
  { name: 'Morpho', protocol: 'morpho-markets-v1' },
];

// Aave V3 Pool contract on Polygon (for liquidity checks)
const AAVE_POOL_ADDRESS = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const AAVE_POOL_ABI = [
  'function getReserveData(address asset) external view returns (uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury)',
];
const ERC20_ABI = ['function totalSupply() view returns (uint256)'];

// Worker class
class Worker {
  private running = true;
  private currentCandidate: OpportunityCandidate | null = null;

  async start() {
    while (this.running) {
      if (candidateQueue.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      const candidate = candidateQueue.shift();
      if (!candidate) continue;

      this.currentCandidate = candidate;
      try {
        await this.processCandidate(candidate);
      } catch (err) {
        log.error(`Worker error processing candidate ${candidate.id}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.currentCandidate = null;
      }
    }
  }

  stop() {
    this.running = false;
  }

  private async processCandidate(candidate: OpportunityCandidate): Promise<void> {
    if (isBreakerTripped()) {
      log.warn('Circuit breaker tripped, skipping candidate', { candidateId: candidate.id });
      return;
    }

    const age = Date.now() - candidate.sourceTimestamp;
    if (age > MAX_OPPORTUNITY_AGE_MS) {
      log.warn(`Candidate too stale: ${candidate.id}`, { age });
      await alertTradeFailed(candidate.id, `Discarded before dispatch, already ${age}ms old`);
      return;
    }

    if (!canStartNewTrade({ activeTrades: getActiveTradeCount() })) {
      log.debug('Concurrency limit reached, requeueing candidate', { candidateId: candidate.id });
      candidateQueue.push(candidate);
      return;
    }

    // 1. Select best flashloan option BEFORE building the plan
    const flashloanOption = await selectBestFlashloanOption(candidate, candidate.estimatedNetProfitUsd);
    if (!flashloanOption) {
      log.error(`No suitable flashloan option for ${candidate.id}`);
      await alertTradeFailed(candidate.id, 'No suitable flashloan option');
      return;
    }

    // 2. Build action plan with the selected token and provider
    let plan: ActionPlan;
    try {
      plan = await buildActionPlanForCandidate(candidate, {
        flashLoanToken: flashloanOption.token,
        flashLoanProvider: flashloanOption.provider,
      });
    } catch (err) {
      log.error(`Failed to build action plan for ${candidate.id}`, { error: String(err) });
      await alertTradeFailed(candidate.id, `Action plan build failed: ${String(err)}`);
      return;
    }

    // 3. Log opportunity and trade in a single transaction
    let opportunityId: number;
    let tradeId: number;
    try {
      const result = await logOpportunityAndTrade(
        {
          pairId: candidate.id,
          baseSymbol: 'unknown',
          quoteSymbol: 'unknown',
          sourceBuy: candidate.strategy,
          sourceSell: 'execution',
          priceBuy: 0,
          priceSell: 0,
          spreadBps: 0,
          estLiquidityUsd: 0,
          estGasCostUsd: candidate.estimatedCostUsd,
          estProtocolFeeUsd: 0,
          estNetProfitUsd: candidate.estimatedNetProfitUsd,
          meetsThreshold: true,
          strategy: candidate.strategy,
        },
        {
          pairId: candidate.id,
          status: 'pending',
          positionSizeUsd: candidate.estimatedNetProfitUsd,
          expectedProfitUsd: candidate.estimatedNetProfitUsd,
        }
      );
      opportunityId = result.opportunityId;
      tradeId = result.tradeId;
    } catch (err) {
      log.error(`Failed to log opportunity/trade for ${candidate.id}`, { error: String(err) });
      await alertTradeFailed(candidate.id, `Database logging failed: ${String(err)}`);
      return;
    }

    await updateTradeStatus(tradeId, 'submitted');

    // 4. Capture balance BEFORE execution
    let balanceBefore: ethers.BigNumber | null = null;
    try {
      balanceBefore = await getTokenBalance(flashloanOption.token);
    } catch (err) {
      log.warn('Failed to read pre-trade balance', {
        token: flashloanOption.token.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 5. Execute
    let success = false;
    let lastError: string | null = null;
    let txHash: string | undefined;
    let gasUsed: string | undefined;

    try {
      const built = await buildBundleFromPlan(plan);

      // Simulation check
      try {
        const enso = getEnsoClient();
        if (built.bundleData?.simulation?.success === false) {
          throw new Error(`Simulation failed: ${built.bundleData?.simulation?.error || 'unknown reason'}`);
        }
      } catch (simErr: any) {
        throw new Error(`Simulation failed: ${simErr.message}`);
      }

      const result = await executeBundle(built);
      if (!result.success) {
        throw new Error(result.errorMessage || 'Execution failed');
      }

      txHash = result.txHash;
      gasUsed = result.gasUsed;
      success = true;

      // 6. Measure actual profit
      let actualNetProfitUsd: number | null = null;
      try {
        const balanceAfter = await getTokenBalance(flashloanOption.token);
        if (balanceBefore) {
          const deltaRaw = balanceAfter.sub(balanceBefore);
          const deltaHuman = Number(ethers.utils.formatUnits(deltaRaw, flashloanOption.token.decimals));
          const priceUsd = await getLiveTokenPriceUsd(flashloanOption.token);
          actualNetProfitUsd = deltaHuman * priceUsd;
        }
      } catch (balErr) {
        log.warn('Failed to measure actual post-trade profit', {
          error: balErr instanceof Error ? balErr.message : String(balErr),
        });
      }

      await updateTradeStatus(tradeId, 'confirmed', {
        txHash,
        gasUsed: gasUsed ? Number(gasUsed) : undefined,
        actualProfitUsd: actualNetProfitUsd ?? undefined,
      });

      log.info(`✅ Trade executed with ${flashloanOption.provider.name} / ${flashloanOption.token.symbol}`, {
        candidateId: candidate.id,
        txHash,
        estimatedNetProfitUsd: candidate.estimatedNetProfitUsd.toFixed(4),
        actualNetProfitUsd: actualNetProfitUsd !== null ? actualNetProfitUsd.toFixed(4) : 'unavailable',
      });

      await alertTradeExecuted(
        candidate.id,
        actualNetProfitUsd !== null ? actualNetProfitUsd : candidate.estimatedNetProfitUsd,
        txHash ?? 'unknown'
      );
    } catch (err: any) {
      lastError = err.message || String(err);
    }

    if (!success) {
      await updateTradeStatus(tradeId, 'failed', { errorMessage: lastError || 'Unknown error' });
      log.warn('❌ Trade failed', {
        candidateId: candidate.id,
        error: lastError,
      });
      await alertTradeFailed(candidate.id, lastError || 'Unknown error');
    }
  }
}

/**
 * Select the best flashloan option (token + provider) for a candidate.
 * Uses real Aave V3 reserve data: available liquidity = aToken.totalSupply - variableDebtToken.totalSupply
 * Converts to USD using live price, and picks the token with the highest available USD liquidity
 * that comfortably exceeds the required amount (2x margin).
 */
async function selectBestFlashloanOption(
  candidate: OpportunityCandidate,
  requiredUsd: number
): Promise<{ token: TokenInfo; provider: FlashLoanProvider } | null> {
  const candidates = FLASH_LOAN_CANDIDATES.filter(
    t => t.address.toLowerCase() !== candidate.actionPlan?.flashLoanToken?.address?.toLowerCase()
  );

  if (candidates.length === 0) return null;

  const pool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);
  let bestToken: TokenInfo | null = null;
  let bestAvailableUsd = 0;
  let bestProvider: FlashLoanProvider = PROVIDER_ORDER[0]; // default to Aave V3

  for (const token of candidates) {
    try {
      const reserveData = await withRetry(
        () => pool.getReserveData(token.address),
        { label: `queue.liquidity.${token.symbol}`, shouldRetry: isTransientError, retries: 2 }
      );
      const aTokenAddress = reserveData.aTokenAddress;
      const variableDebtAddress = reserveData.variableDebtTokenAddress;

      const aToken = new ethers.Contract(aTokenAddress, ERC20_ABI, provider);
      const debtToken = new ethers.Contract(variableDebtAddress, ERC20_ABI, provider);

      const [aTotalSupply, debtTotalSupply] = await Promise.all([
        aToken.totalSupply(),
        debtToken.totalSupply(),
      ]);

      const availableRaw = aTotalSupply.sub(debtTotalSupply);
      if (availableRaw.lte(0)) {
        log.debug(`Token ${token.symbol} has no available liquidity`);
        continue;
      }

      const priceUsd = await getLiveTokenPriceUsd(token);
      const availableUsd = Number(ethers.utils.formatUnits(availableRaw, token.decimals)) * priceUsd;

      // Require at least 2x the required amount to avoid edge cases
      if (availableUsd < requiredUsd * 2) {
        log.debug(`Token ${token.symbol} available liquidity $${availableUsd.toFixed(2)} < 2x required, skipping`);
        continue;
      }

      if (availableUsd > bestAvailableUsd) {
        bestAvailableUsd = availableUsd;
        bestToken = token;
        // For now, always prefer Aave V3; Morpho comparison can be added later
        bestProvider = PROVIDER_ORDER[0];
        log.debug(`Selected ${token.symbol} with $${availableUsd.toFixed(2)} liquidity`);
      }
    } catch (err) {
      log.debug(`Failed to get liquidity for ${token.symbol}`, { error: String(err) });
      continue;
    }
  }

  if (!bestToken) {
    // fallback: pick the first candidate with any liquidity > 0
    for (const token of candidates) {
      try {
        const reserveData = await withRetry(
          () => pool.getReserveData(token.address),
          { label: `queue.liquidity.${token.symbol}`, shouldRetry: isTransientError, retries: 1 }
        );
        const aTokenAddress = reserveData.aTokenAddress;
        const variableDebtAddress = reserveData.variableDebtTokenAddress;
        const aToken = new ethers.Contract(aTokenAddress, ERC20_ABI, provider);
        const debtToken = new ethers.Contract(variableDebtAddress, ERC20_ABI, provider);
        const [aTotalSupply, debtTotalSupply] = await Promise.all([
          aToken.totalSupply(),
          debtToken.totalSupply(),
        ]);
        const availableRaw = aTotalSupply.sub(debtTotalSupply);
        if (availableRaw.gt(0)) {
          bestToken = token;
          bestProvider = PROVIDER_ORDER[0];
          const priceUsd = await getLiveTokenPriceUsd(token);
          bestAvailableUsd = Number(ethers.utils.formatUnits(availableRaw, token.decimals)) * priceUsd;
          log.debug(`Fallback: selected ${token.symbol} with $${bestAvailableUsd.toFixed(2)} liquidity`);
          break;
        }
      } catch { /* ignore */ }
    }
  }

  if (!bestToken) {
    log.warn('No suitable flashloan token found for candidate');
    return null;
  }

  log.info(`Selected flashloan token: ${bestToken.symbol}, available liquidity: $${bestAvailableUsd.toFixed(2)}`);
  return { token: bestToken, provider: bestProvider };
}

// Build action plan with optional flashloan token/provider override
async function buildActionPlanForCandidate(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  switch (candidate.strategy) {
    case 'lpEntryExit':
      return buildLPActionPlan(candidate, options);
    case 'vaultArb':
      return buildVaultActionPlan(candidate, options);
    case 'debtPosition':
      return buildDebtActionPlan(candidate, options);
    case 'harvestShort':
      return buildHarvestActionPlan(candidate, options);
    case 'classicIncentive':
      return buildClassicActionPlan(candidate, options);
    default:
      throw new Error(`Unknown strategy: ${candidate.strategy}`);
  }
}

// Token balance helper
async function getTokenBalance(token: TokenInfo): Promise<ethers.BigNumber> {
  const contract = new ethers.Contract(
    token.address,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );
  return contract.balanceOf(executionWallet.address);
}

// Worker pool management
export function startWorkerPool(): void {
  if (workerPool.length > 0) return;
  log.info(`Starting worker pool with ${WORKER_COUNT} workers`);
  for (let i = 0; i < WORKER_COUNT; i++) {
    const worker = new Worker();
    workerPool.push(worker);
    worker.start().catch(err => {
      log.error(`Worker ${i} crashed`, { error: err instanceof Error ? err.message : String(err) });
    });
  }
}

export function stopWorkerPool(): void {
  for (const worker of workerPool) {
    worker.stop();
  }
  workerPool = [];
}

// Push candidate to queue (called by scan loop)
export function pushCandidate(candidate: OpportunityCandidate): void {
  candidateQueue.push(candidate);
}

// Get active trade count (rough estimate from workers currently processing)
export function getActiveTradeCount(): number {
  return workerPool.filter(w => w['currentCandidate'] !== null).length;
}

// Legacy batch processor for backward compatibility
export async function processCandidates(candidates: OpportunityCandidate[]): Promise<void> {
  for (const c of candidates) {
    pushCandidate(c);
  }
}
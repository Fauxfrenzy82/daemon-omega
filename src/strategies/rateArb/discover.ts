// src/strategies/rateArb/discover.ts
import { ethers } from 'ethers';
import { provider } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { TOKENS } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { pushCandidate } from '../../execution/queue';

const log = createLogger('rateArb');

// Aave V3 Pool on Polygon
const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const AAVE_ABI = [
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury)',
];

// Morpho Blue GraphQL API
const MORPHO_API = 'https://blue-api.morpho.org/graphql';

// Assets to monitor
const ASSETS = [
  TOKENS.USDC,
  TOKENS.WETH,
  TOKENS.WBTC,
  TOKENS.WMATIC,
  TOKENS.USDT,
];

// We'll test these flashloan amounts
const TEST_AMOUNTS = [300, 500, 1000, 25000, 50000, 100000];

async function fetchAaveRates(): Promise<Record<string, { supplyApy: number; borrowApy: number }>> {
  const pool = new ethers.Contract(AAVE_POOL, AAVE_ABI, provider);
  const rates: Record<string, any> = {};

  for (const asset of ASSETS) {
    try {
      const data = await pool.getReserveData(asset.address);
      const supplyApy = Number(data.currentLiquidityRate) / 1e27 * 100;
      const borrowApy = Number(data.currentVariableBorrowRate) / 1e27 * 100;
      rates[asset.symbol] = { supplyApy, borrowApy };
    } catch (err) {
      log.debug(`Failed to fetch Aave rate for ${asset.symbol}: ${String(err)}`);
    }
  }
  return rates;
}

async function fetchMorphoRates(): Promise<Record<string, { supplyApy: number; borrowApy: number }>> {
  const query = `{
    markets(where: { chainId_in: [137] }, first: 50) {
      items {
        marketId
        loanAsset { symbol address decimals }
        collateralAsset { symbol address decimals }
        state { borrowApy supplyApy }
      }
    }
  }`;

  try {
    const res = await fetch(MORPHO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    const json: any = await res.json();
    
    // ✅ Check if data exists and has the expected structure
    if (!json.data || !json.data.markets || !json.data.markets.items) {
      log.warn('Morpho API returned unexpected structure', { data: json });
      return {};
    }
    
    const items = json.data.markets.items;
    const rates: Record<string, { supplyApy: number; borrowApy: number }> = {};

    for (const item of items) {
      // ✅ Add null checks for each field
      if (!item || !item.loanAsset || !item.loanAsset.symbol) {
        log.debug('Skipping invalid Morpho market item', { item });
        continue;
      }
      
      const symbol = item.loanAsset.symbol;
      if (!ASSETS.find(a => a.symbol === symbol)) continue;
      
      // Morpho rates are already in percentage (e.g., 0.05 = 5%)
      // Store a generic entry (first collateral found)
      if (!rates[symbol]) {
        rates[symbol] = { 
          supplyApy: item.state?.supplyApy ? item.state.supplyApy * 100 : 0, 
          borrowApy: item.state?.borrowApy ? item.state.borrowApy * 100 : 0 
        };
      }
    }
    return rates;
  } catch (err) {
    log.error('Failed to fetch Morpho rates', { error: String(err) });
    return {};
  }
}

export async function discoverRateArbitrage(nativePrice: number) {
  const candidates: OpportunityCandidate[] = [];
  const aaveRates = await fetchAaveRates();
  const morphoRates = await fetchMorphoRates();

  log.info('📊 Aave rates (APY %):', aaveRates);
  log.info('📊 Morpho rates (APY %):', morphoRates);

  const gasPrice = await provider.getGasPrice();
  const gasUnits = 500000; // estimated for flashloan + deposit + borrow
  const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasUnits)));
  const gasCostUsd = gasCostNative * nativePrice;

  // For each asset, find if there's a positive spread
  for (const symbol of Object.keys(aaveRates)) {
    const aaveSupply = aaveRates[symbol]?.supplyApy || 0;
    const aaveBorrow = aaveRates[symbol]?.borrowApy || 0;

    // Find Morpho entry for same asset (generic)
    const morphoEntry = morphoRates[symbol];
    if (!morphoEntry) continue;

    const morphoSupply = morphoEntry.supplyApy || 0;
    const morphoBorrow = morphoEntry.borrowApy || 0;

    // Spreads
    const spread1 = aaveSupply - morphoBorrow; // borrow from Morpho, deposit to Aave
    const spread2 = morphoSupply - aaveBorrow; // borrow from Aave, deposit to Morpho

    for (const amount of TEST_AMOUNTS) {
      // Case 1
      if (spread1 > 0) {
        const dailyProfit = (amount * (spread1 / 100)) / 365;
        const netProfit = dailyProfit - gasCostUsd;
        log.info(`🔍 Rate arb (Morpho borrow → Aave supply) for ${symbol}:`, {
          amount,
          spreadBps: (spread1 * 100).toFixed(2),
          dailyProfit: dailyProfit.toFixed(4),
          gasCostUsd: gasCostUsd.toFixed(4),
          netProfit: netProfit.toFixed(4),
        });
        if (netProfit > 0.01) {
          const candidate: OpportunityCandidate = {
            id: `ratearb-${symbol}-morpho-aave-${Date.now()}`,
            strategy: 'rateArb',
            protocol: 'aave-v3',
            params: {
              type: 'morphoBorrowAaveSupply',
              asset: symbol,
              amountUsd: amount,
              spreadBps: spread1 * 100,
              dailyProfit,
              gasCostUsd,
              netProfit,
              nativePrice,
            },
            estimatedGrossProfitUsd: dailyProfit,
            estimatedNetProfitUsd: netProfit,
            estimatedCostUsd: gasCostUsd,
            actionPlan: null,
            sourceTimestamp: Date.now(),
          };
          pushCandidate(candidate);
          candidates.push(candidate);
        }
      }

      // Case 2
      if (spread2 > 0) {
        const dailyProfit = (amount * (spread2 / 100)) / 365;
        const netProfit = dailyProfit - gasCostUsd;
        log.info(`🔍 Rate arb (Aave borrow → Morpho supply) for ${symbol}:`, {
          amount,
          spreadBps: (spread2 * 100).toFixed(2),
          dailyProfit: dailyProfit.toFixed(4),
          gasCostUsd: gasCostUsd.toFixed(4),
          netProfit: netProfit.toFixed(4),
        });
        if (netProfit > 0.01) {
          const candidate: OpportunityCandidate = {
            id: `ratearb-${symbol}-aave-morpho-${Date.now()}`,
            strategy: 'rateArb',
            protocol: 'morpho-markets-v1',
            params: {
              type: 'aaveBorrowMorphoSupply',
              asset: symbol,
              amountUsd: amount,
              spreadBps: spread2 * 100,
              dailyProfit,
              gasCostUsd,
              netProfit,
              nativePrice,
            },
            estimatedGrossProfitUsd: dailyProfit,
            estimatedNetProfitUsd: netProfit,
            estimatedCostUsd: gasCostUsd,
            actionPlan: null,
            sourceTimestamp: Date.now(),
          };
          pushCandidate(candidate);
          candidates.push(candidate);
        }
      }
    }
  }

  log.info('Rate arbitrage discovery complete', { totalCandidates: candidates.length });
  return candidates;
}
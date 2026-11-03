// src/strategies/arbitrage/buildActionPlan.ts
import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';
import { TOKENS } from '../../config/tokens';
import { createLogger } from '../../utils/logger';
import { VenueHop } from '../../scanner/sources/ensoMultiVenue';

const log = createLogger('arbitrage-build');

// Morpho Blue Polygon address
const MORPHO_BLUE = '0x6c247b1F6182318877311737BaC0844bAa518F5e';
// Aave V3 Pool Addresses Provider (fallback)
const AAVE_V3_POOL_ADDRESSES_PROVIDER = '0xa97684ead0e402dc232d5a977953df7ecbab3cdb';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const params = candidate.params;
  const type = params.type || 'crossdex';

  // Use Morpho for 0% flashloan fee
  const flashLoanProvider = options?.flashLoanProvider || {
    name: 'Morpho',
    protocol: 'morpho-markets-v1',
  };

  const flashLoanToken = options?.flashLoanToken || TOKENS.USDC;
  const flashLoanAmount = ethers.utils.parseUnits(
    params.amountUsd.toString(),
    flashLoanToken.decimals
  ).toString();

  let steps: ActionStep[] = [];

  if (type === 'crossdex') {
    // Cross-DEX: Buy on venue A, sell on venue B - each leg pinned to the
    // exact venue (protocol + router/pool) that the scanner quoted.
    const buyVenue = params.buyVenue;
    const sellVenue = params.sellVenue;
    const tokenB = params.tokenB;

    const buyHops: VenueHop[] = params.buyQuote?.hops ?? [];
    const sellHops: VenueHop[] = params.sellQuote?.hops ?? [];

    // Fail closed: without a verified venue route we must not execute, because
    // a generic Enso route would trade somewhere other than the quoted venue.
    if (buyHops.length === 0 || sellHops.length === 0) {
      throw new Error(
        `No pinned venue route for ${params.pair} (${buyVenue} -> ${sellVenue}); refusing generic route`
      );
    }
    assertLegMatches('buy', buyHops, flashLoanToken.address, tokenB.address);
    assertLegMatches('sell', sellHops, tokenB.address, flashLoanToken.address);

    const buySteps = hopsToSteps(buyHops, flashLoanAmount, 0);
    const sellSteps = hopsToSteps(sellHops, { useOutputOfCallAt: buySteps.length - 1 }, buySteps.length);

    const flashloanStep: ActionStep = {
      type: 'flashloan',
      protocol: flashLoanProvider.protocol,
      flashloanToken: flashLoanToken.address,
      flashloanAmount: flashLoanAmount,
      primaryAddress: MORPHO_BLUE,
      callback: [...buySteps, ...sellSteps],
    };

    steps = [flashloanStep];

    log.info('Cross-DEX arbitrage action plan built (venue-pinned)', {
      amountUsd: params.amountUsd,
      pair: params.pair,
      buyVenue,
      sellVenue,
      buyPools: buyHops.map((h) => h.primaryAddress),
      sellPools: sellHops.map((h) => h.primaryAddress),
      flashloanProtocol: flashLoanProvider.protocol,
    });
  } else {
    // Fallback: triangular arbitrage
    const path = params.tokenPath;
    if (!path) {
      throw new Error('No path specified for arbitrage');
    }
    const tokenA = getTokenBySymbol(path[1]);
    const tokenB = getTokenBySymbol(path[2]);

    const step1: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: flashLoanToken.address,
      tokenOut: tokenA.address,
      amountIn: flashLoanAmount,
      slippage: '100',
    };
    const step2: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: tokenA.address,
      tokenOut: tokenB.address,
      amountIn: { useOutputOfCallAt: 0 },
      slippage: '100',
    };
    const step3: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: tokenB.address,
      tokenOut: flashLoanToken.address,
      amountIn: { useOutputOfCallAt: 1 },
      slippage: '100',
    };

    const flashloanStep: ActionStep = {
      type: 'flashloan',
      protocol: flashLoanProvider.protocol,
      flashloanToken: flashLoanToken.address,
      flashloanAmount: flashLoanAmount,
      primaryAddress: MORPHO_BLUE,
      callback: [step1, step2, step3],
    };

    steps = [flashloanStep];

    log.info('Triangular arbitrage action plan built (fallback)', {
      amountUsd: params.amountUsd,
      path: path.join('→'),
      flashloanProtocol: flashLoanProvider.protocol,
    });
  }

  return {
    flashLoanToken,
    flashLoanAmount,
    steps,
  };
}

function getTokenBySymbol(symbol: string): TokenInfo {
  const map: Record<string, TokenInfo> = {
    USDC: TOKENS.USDC,
    USDT: TOKENS.USDT,
    DAI: TOKENS.DAI,
    WETH: TOKENS.WETH,
    WBTC: TOKENS.WBTC,
    WMATIC: TOKENS.WMATIC,
    AAVE: TOKENS.AAVE,
  };
  if (!map[symbol]) throw new Error(`Unknown token: ${symbol}`);
  return map[symbol];
}

// Convert venue hops into pinned swap steps. The first hop consumes `firstAmountIn`;
// every later hop consumes the output of the action right before it.
// `offset` is the index this leg's first step will have inside the callback.
function hopsToSteps(
  hops: VenueHop[],
  firstAmountIn: string | { useOutputOfCallAt: number },
  offset: number
): ActionStep[] {
  return hops.map((hop, i) => ({
    type: 'swap',
    protocol: 'enso',
    tokenIn: hop.tokenIn,
    tokenOut: hop.tokenOut,
    amountIn: i === 0 ? firstAmountIn : { useOutputOfCallAt: offset + i - 1 },
    slippage: '100',
    venue: {
      protocol: hop.protocol,
      action: hop.action,
      primaryAddress: hop.primaryAddress,
      ...(hop.poolFee !== undefined ? { poolFee: hop.poolFee } : {}),
    },
  }));
}

// A leg must start and end on the tokens the plan expects, otherwise the
// callback would not hand the flash-loan token back.
function assertLegMatches(leg: string, hops: VenueHop[], tokenIn: string, tokenOut: string): void {
  const startsOk = hops[0].tokenIn.toLowerCase() === tokenIn.toLowerCase();
  const endsOk = hops[hops.length - 1].tokenOut.toLowerCase() === tokenOut.toLowerCase();
  if (!startsOk || !endsOk) {
    throw new Error(`Pinned ${leg} route does not match expected tokens (${tokenIn} -> ${tokenOut})`);
  }
}

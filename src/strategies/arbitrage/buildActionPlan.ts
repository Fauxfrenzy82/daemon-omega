// src/strategies/arbitrage/buildActionPlan.ts
import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';
import { TOKENS } from '../../config/tokens';
import { createLogger } from '../../utils/logger';

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
    // Cross-DEX: Buy on venue A, sell on venue B
    const buyVenue = params.buyVenue;
    const sellVenue = params.sellVenue;
    const tokenA = params.tokenA;
    const tokenB = params.tokenB;

    const buyStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: flashLoanToken.address,
      tokenOut: tokenB.address,
      amountIn: flashLoanAmount,
      slippage: '100',
      primaryAddress: buyVenue === 'uniswap-v3' ? '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' : undefined,
    };

    const sellStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: tokenB.address,
      tokenOut: flashLoanToken.address,
      amountIn: { useOutputOfCallAt: 0 },
      slippage: '100',
      primaryAddress: sellVenue === 'uniswap-v3' ? '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' : undefined,
    };

    const flashloanStep: ActionStep = {
      type: 'flashloan',
      protocol: flashLoanProvider.protocol,
      flashloanToken: flashLoanToken.address,
      flashloanAmount: flashLoanAmount,
      primaryAddress: MORPHO_BLUE,
      callback: [buyStep, sellStep],
    };

    steps = [flashloanStep];

    log.info('Cross-DEX arbitrage action plan built', {
      amountUsd: params.amountUsd,
      pair: params.pair,
      buyVenue,
      sellVenue,
      flashloanProtocol: flashLoanProvider.protocol,
    });
  } else {
    // Fallback: triangular arbitrage (if anyone still uses it)
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
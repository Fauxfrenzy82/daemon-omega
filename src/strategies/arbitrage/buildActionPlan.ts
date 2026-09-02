// src/strategies/arbitrage/buildActionPlan.ts

import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';
import { TOKENS } from '../../config/tokens';
import { createLogger } from '../../utils/logger';

const log = createLogger('arbitrage-build');

const AAVE_V3_POOL_ADDRESSES_PROVIDER = '0xa97684ead0e402dc232d5a977953df7ecbab3cdb';
const MORPHO_PROTOCOL = 'morpho-markets-v1';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const params = candidate.params;
  const type = params.type;

  // Use Morpho for 0% flashloan fee
  const flashLoanProvider = options?.flashLoanProvider || {
    name: 'Morpho',
    protocol: MORPHO_PROTOCOL,
  };

  // Determine flashloan token (USDC is the entry token for most arbitrage)
  const flashLoanToken = options?.flashLoanToken || TOKENS.USDC;
  const flashLoanAmount = ethers.utils.parseUnits(
    params.amountUsd.toString(),
    flashLoanToken.decimals
  ).toString();

  let steps: ActionStep[] = [];

  if (type === 'triangular') {
    // Triangular: USDC → TokenA → TokenB → USDC
    const [entryToken, tokenA, tokenB, exitToken] = params.tokenPath;
    
    // Find the actual token objects
    const tokenAInfo = getTokenBySymbol(tokenA);
    const tokenBInfo = getTokenBySymbol(tokenB);

    const step1: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: flashLoanToken.address,
      tokenOut: tokenAInfo.address,
      amountIn: flashLoanAmount,
      slippage: '100',
    };

    const step2: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: tokenAInfo.address,
      tokenOut: tokenBInfo.address,
      amountIn: { useOutputOfCallAt: 0 },
      slippage: '100',
    };

    const step3: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: tokenBInfo.address,
      tokenOut: flashLoanToken.address,
      amountIn: { useOutputOfCallAt: 1 },
      slippage: '100',
    };

    const flashloanStep: ActionStep = {
      type: 'flashloan',
      protocol: flashLoanProvider.protocol,
      flashloanToken: flashLoanToken.address,
      flashloanAmount: flashLoanAmount,
      primaryAddress: AAVE_V3_POOL_ADDRESSES_PROVIDER,
      callback: [step1, step2, step3],
    };

    steps = [flashloanStep];
  } else if (type === 'crossdex') {
    // Cross-DEX: Buy on venue A, sell on venue B
    const [tokenA, tokenB] = params.tokenPath;
    const tokenAInfo = getTokenBySymbol(tokenA);
    const tokenBInfo = getTokenBySymbol(tokenB);

    // Use the specific venues from the quote
    const buyVenue = params.details.spread.buyVenue;
    const sellVenue = params.details.spread.sellVenue;

    const buyStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: flashLoanToken.address,
      tokenOut: tokenBInfo.address,
      amountIn: flashLoanAmount,
      slippage: '100',
      primaryAddress: buyVenue === 'uniswap-v3' ? '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' : undefined,
    };

    const sellStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: tokenBInfo.address,
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
      primaryAddress: AAVE_V3_POOL_ADDRESSES_PROVIDER,
      callback: [buyStep, sellStep],
    };

    steps = [flashloanStep];
  }

  log.info('✅ Arbitrage action plan built', {
    type,
    amountUsd: params.amountUsd,
    path: params.tokenPath,
    flashloanProtocol: flashLoanProvider.protocol,
  });

  return {
    flashLoanToken,
    flashLoanAmount,
    steps,
  };
}

// Helper to get token by symbol
function getTokenBySymbol(symbol: string): TokenInfo {
  const tokenMap: Record<string, TokenInfo> = {
    'USDC': TOKENS.USDC,
    'USDT': TOKENS.USDT,
    'DAI': TOKENS.DAI,
    'WETH': TOKENS.WETH,
    'WBTC': TOKENS.WBTC,
    'WMATIC': TOKENS.WMATIC,
    'AAVE': TOKENS.AAVE,
  };
  
  const token = tokenMap[symbol];
  if (!token) throw new Error(`Unknown token symbol: ${symbol}`);
  return token;
}
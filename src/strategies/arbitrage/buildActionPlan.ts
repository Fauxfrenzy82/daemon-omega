// src/strategies/arbitrage/buildActionPlan.ts
import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';
import { TOKENS } from '../../config/tokens';
import { createLogger } from '../../utils/logger';

const log = createLogger('arbitrage-build');

// ✅ Morpho Blue Polygon address (from official docs)
const MORPHO_BLUE_POLYGON = '0x6c247b1F6182318877311737BaC0844bAa518F5e';
// ✅ Protocol identifier for Enso – must match Enso's supported protocols
const FLASHLOAN_PROTOCOL = 'morpho-markets-v1';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const params = candidate.params;
  const flashLoanToken = options?.flashLoanToken || TOKENS.USDC;
  const flashLoanAmount = ethers.utils.parseUnits(
    params.amountUsd.toString(),
    flashLoanToken.decimals
  ).toString();

  const path = params.tokenPath; // ['USDC', 'A', 'B', 'USDC']
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
    protocol: FLASHLOAN_PROTOCOL,
    flashloanToken: flashLoanToken.address,
    flashloanAmount: flashLoanAmount,
    primaryAddress: MORPHO_BLUE_POLYGON, // ✅ Morpho Blue on Polygon
    callback: [step1, step2, step3],
  };

  log.info('Arbitrage action plan built (Morpho flashloan)', {
    amountUsd: params.amountUsd,
    path: path.join('→'),
    flashloanProtocol: FLASHLOAN_PROTOCOL,
    fee: '0%',
  });

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

function getTokenBySymbol(symbol: string): TokenInfo {
  const map: Record<string, TokenInfo> = {
    USDC: TOKENS.USDC,
    USDT: TOKENS.USDT,
    WETH: TOKENS.WETH,
    WBTC: TOKENS.WBTC,
    WMATIC: TOKENS.WMATIC,
  };
  if (!map[symbol]) throw new Error(`Unknown token: ${symbol}`);
  return map[symbol];
}
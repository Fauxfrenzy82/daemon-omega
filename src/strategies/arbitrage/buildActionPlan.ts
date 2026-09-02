// src/strategies/arbitrage/buildActionPlan.ts
import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';
import { TOKENS } from '../../config/tokens';
import { createLogger } from '../../utils/logger';

const log = createLogger('arbitrage-build');

const AAVE_V3_POOL_ADDRESSES_PROVIDER = '0xa97684ead0e402dc232d5a977953df7ecbab3cdb';
const FLASHLOAN_PROTOCOL = 'aave-v3';

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
    primaryAddress: AAVE_V3_POOL_ADDRESSES_PROVIDER,
    callback: [step1, step2, step3],
  };

  log.info('Arbitrage action plan built', {
    amountUsd: params.amountUsd,
    path: path.join('→'),
    flashloanProtocol: FLASHLOAN_PROTOCOL,
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
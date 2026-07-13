import * as api from '@protocolink/api';
import { TokenInfo } from '../config/tokens';
import { EvaluatedOpportunity } from '../profitability/evaluator';
import { getChainId } from './protocolinkClient';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';
import { env } from '../config/env';

const log = createLogger('logicBuilder');

export interface BuiltLogics {
  logics: any[];
  flashLoanAmount: string;
  flashLoanToken: TokenInfo;
}

export interface RequoteOptions {
  buyRequiresRequote?: boolean;
  sellRequiresRequote?: boolean;
}

function toProtocolinkToken(chainId: number, token: TokenInfo) {
  return {
    chainId,
    address: token.address,
    decimals: token.decimals,
    symbol: token.symbol,
    name: token.name,
  };
}

export async function buildArbitrageLogics(
  opp: EvaluatedOpportunity,
  flashLoanToken: TokenInfo,
  flashLoanAmountRaw: string,
  options: RequoteOptions = {}
): Promise<BuiltLogics> {
  const chainId = getChainId();
  const logics: any[] = [];

  // Flash loan from Aave V3
  const flashLoanLogic = await api.protocols.aavev3.newFlashLoanLogic({
    id: 'aave-v3-flashloan',
    isLoan: true,
    loans: [
      {
        token: toProtocolinkToken(chainId, flashLoanToken),
        amount: flashLoanAmountRaw,
      },
    ],
  });
  logics.push(flashLoanLogic);

  // Buy-side swap
  const buySource = opp.spreadOpp.buySource;
  const buyRequiresRequote = options.buyRequiresRequote || false;
  const buyLogic = await buildSwapLogic(
    buySource,
    buyRequiresRequote,
    opp.pair.quote,
    opp.pair.base,
    flashLoanAmountRaw,
    opp
  );
  if (!buyLogic) {
    throw new Error(`Failed to build buy swap logic for source ${buySource}`);
  }
  logics.push(buyLogic);

  // Sell-side swap
  const sellSource = opp.spreadOpp.sellSource;
  const sellRequiresRequote = options.sellRequiresRequote || false;
  const buyOutputAmount = opp.spreadOpp.buyQuote.amountOut;
  const sellLogic = await buildSwapLogic(
    sellSource,
    sellRequiresRequote,
    opp.pair.base,
    opp.pair.quote,
    buyOutputAmount,
    opp
  );
  if (!sellLogic) {
    throw new Error(`Failed to build sell swap logic for source ${sellSource}`);
  }
  logics.push(sellLogic);

  log.info('Built arbitrage logic sequence', {
    pairId: opp.pair.id,
    buySource: buyRequiresRequote ? `${buySource}→requoted` : buySource,
    sellSource: sellRequiresRequote ? `${sellSource}→requoted` : sellSource,
    steps: logics.length,
  });

  return {
    logics,
    flashLoanAmount: flashLoanAmountRaw,
    flashLoanToken,
  };
}
import { TokenInfo } from '../config/tokens';
import { EvaluatedOpportunity } from '../profitability/evaluator';
import { executionWallet } from '../treasury/wallets';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import axios from 'axios';
import { env } from '../config/env';

const log = createLogger('ensoBuilder');

export interface BuiltBundle {
  bundleData: any;
  flashLoanAmount: string;
  flashLoanToken: TokenInfo;
}

export interface FlashLoanProvider {
  name: string;
  protocol: 'aave-v3' | 'morpho-markets-v1' | 'balancer-v3' | 'uniswap-v3';
}

export const FLASH_LOAN_PROVIDERS: FlashLoanProvider[] = [
  { name: 'Aave V3', protocol: 'aave-v3' },
  { name: 'Morpho', protocol: 'morpho-markets-v1' },
  { name: 'Balancer V3', protocol: 'balancer-v3' },
  { name: 'Uniswap V3', protocol: 'uniswap-v3' },
];

export async function buildArbitrageBundle(
  opp: EvaluatedOpportunity,
  flashLoanToken: TokenInfo,
  flashLoanAmountRaw: string,
  provider: FlashLoanProvider,
  options: { buyRequiresRequote?: boolean; sellRequiresRequote?: boolean } = {}
): Promise<BuiltBundle> {
  const chainId = activeChain.chainId;
  const fromAddress = executionWallet.address as `0x${string}`;

  const humanAmount = Number(flashLoanAmountRaw) / 10 ** flashLoanToken.decimals;

  log.info('💡 Building Enso flash‑loan bundle (direct HTTP)', {
    pair: opp.pair.id,
    flashLoanToken: flashLoanToken.symbol,
    provider: provider.name,
    amount: humanAmount.toFixed(flashLoanToken.decimals > 6 ? 4 : 2),
    chainId,
  });

  // Build the actions array exactly as before
  const actions = [
    {
      protocol: provider.protocol,
      action: 'flashloan',
      args: {
        flashloanToken: flashLoanToken.address as `0x${string}`,
        flashloanAmount: flashLoanAmountRaw,
        tokenOut: [flashLoanToken.address as `0x${string}`],
        callback: [
          {
            protocol: 'enso',
            action: 'route',
            args: {
              tokenIn: flashLoanToken.address as `0x${string}`,
              tokenOut: opp.pair.base.address as `0x${string}`,
              amountIn: { useOutputOfCallAt: 0 },
              slippage: '100',
            },
          },
          {
            protocol: 'enso',
            action: 'route',
            args: {
              tokenIn: opp.pair.base.address as `0x${string}`,
              tokenOut: flashLoanToken.address as `0x${string}`,
              amountIn: { useOutputOfCallAt: 1 },
              slippage: '100',
            },
          },
        ],
      },
    },
  ];

  // Build the full request payload
  const requestBody = {
    fromAddress,
    chainId,
    routingStrategy: 'router',
    actions,
  };

  log.debug('📦 Enso bundle payload', {
    payload: JSON.stringify(requestBody, null, 2),
  });

  // Determine the correct endpoint
  // According to Enso docs: https://docs.enso.build/pages/build/reference/bundle
  // The endpoint is POST /api/v1/shortcuts/bundle
  const baseUrl = env.ENSO_BASE_URL || 'https://api.enso.build';
  const endpoint = `${baseUrl}/api/v1/shortcuts/bundle`;

  log.info(`📤 POST ${endpoint}`);

  const response = await axios.post(endpoint, requestBody, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.ENSO_API_KEY}`,
    },
    timeout: 15000,
  });

  const bundleData = response.data;

  log.info('✅ Enso bundle created (direct HTTP)', {
    provider: provider.name,
    actionsCount: actions.length,
    hasTx: !!bundleData?.tx,
    status: response.status,
  });

  return {
    bundleData,
    flashLoanAmount: flashLoanAmountRaw,
    flashLoanToken,
  };
}
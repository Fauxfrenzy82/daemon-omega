import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { provider } from '../../treasury/wallets';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TOKENS } from '../../config/tokens';
import { env } from '../../config/env';
import { pushCandidate } from '../../execution/queue';

const log = createLogger('vaultArb');

/**
 * Correct StataToken Factory on Polygon.
 * 
 * Verified from:
 * 1. Aave official GitHub: github.com/aave-dao/aave-address-book
 * 2. Published npm package: @bgd-labs/aave-address-book
 * 
 * Address: 0x1504F1d7b6892600ae0d394F9042e696dd9F87Fa
 * Method: getStaticAToken(address underlying) returns address
 * 
 * Note: This factory is ONLY used as a fallback for assets NOT in the hardcoded map.
 * The hardcoded map is preferred because it avoids an unnecessary RPC call.
 */
const STATATOKEN_FACTORY = '0x1504F1d7b6892600ae0d394F9042e696dd9F87Fa';

const FACTORY_ABI = [
  'function getStaticAToken(address underlying) external view returns (address)',
];

const STATATOKEN_ABI = [
  'function underlying() external view returns (address)',
  'function previewRedeem(uint256 shares) external view returns (uint256)',
  'function previewDeposit(uint256 assets) external view returns (uint256)',
  'function maxWithdraw(address owner) external view returns (uint256)',
  'function maxRedeem(address owner) external view returns (uint256)',
  'function totalAssets() external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
];

/**
 * Hardcoded map of underlying token address → StataToken address.
 * 
 * This map is sourced from the official Aave address book.
 * It is checked FIRST, before any factory call.
 * 
 * If a token is in this map, we use the hardcoded address directly.
 * Only tokens NOT in this map will trigger a factory call.
 * 
 * This avoids unnecessary RPC calls and eliminates the revert risk
 * for known assets.
 * 
 * The keys are the **lowercase** addresses of the underlying tokens.
 */
const STATIC_A_TOKEN_MAP: Record<string, string> = {
  // WMATIC -> WPOL
  '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': '0x98254592408E389D1dd2dBa318656C2C5c305b4E',
  // USDT -> USDT0
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': '0x87A1fdc4C726c459f597282be639a045062c0E46',
  // USDC.e (bridged) -> USDC (bridged) in Aave
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': '0x1017F4a86Fc3A3c824346d0b8C5e96A5029bDAf9',
  // USDC (native) -> USDCn in Aave
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': '0x2dCa80061632f3F87c9cA28364d1d0c30cD79a19',
  // DAI
  '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': '0x83c59636e602787A6EEbBdA2915217B416193FcB',
  // WETH
  '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': '0xb3D5Af0A52a35692D3FcbE37669b3B8C31dddE7D',
  // WBTC
  '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': '0xbC0f50CCB8514Aa7dFEB297521c4BdEBc9C7d22d',
  // AAVE
  '0xd6df932a45c0f255f85145f286ea0b292b21c90b': '0xCA2E1E33E5BCF4978E2d683656E1f5610f8C4A7E',
  // GHST
  '0x385eeac5cb85a38a9a07a70c73e0a3271cfb54a7': '0x123319636A6a9c85D9959399304F4cB23F64327e',
};

function getTokenPriceUsd(token: TokenInfo): number {
  if (['USDC', 'USDC.e', 'USDT', 'DAI'].includes(token.symbol)) {
    return 1.0;
  }
  const priceMap: Record<string, number> = {
    'WMATIC': 0.1,
    'WETH': 3000,
    'WBTC': 60000,
    'AAVE': 150,
    'GHST': 1.5,
  };
  return priceMap[token.symbol] || 0.01;
}

export async function discoverVaultArb(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];
  const factory = new ethers.Contract(STATATOKEN_FACTORY, FACTORY_ABI, provider);

  log.info('🔍 Vault Arbitrage discovery started');

  const tokensToCheck = [
    TOKENS.WMATIC,
    TOKENS.USDT,
    TOKENS.USDCe,
    TOKENS.USDC,
    TOKENS.DAI,
    TOKENS.WETH,
    TOKENS.WBTC,
    TOKENS.AAVE,
    TOKENS.GHST,
  ];

  for (const token of tokensToCheck) {
    try {
      const symbol = token.symbol;
      const underlyingAddress = token.address.toLowerCase();

      // 1. FIRST: Check the hardcoded map.
      let stataAddress = STATIC_A_TOKEN_MAP[underlyingAddress];
      let source = 'hardcoded';

      // 2. ONLY if NOT in map, fall back to the factory.
      if (!stataAddress) {
        // Log that we're falling back to the factory
        log.debug(`Token ${symbol} not in hardcoded map, calling factory`);
        try {
          stataAddress = (await withRetry(
            () => factory.getStaticAToken(token.address),
            { label: `vaultArb.getStaticAToken.${symbol}`, shouldRetry: isTransientError, retries: 2 }
          )) as string;
          source = 'factory';
        } catch (factoryErr) {
          log.debug(`Factory call for ${symbol} failed, skipping`);
          continue;
        }
      }

      if (stataAddress === ethers.constants.AddressZero) {
        log.debug(`No StataToken wrapper for ${symbol} on Polygon`);
        continue;
      }

      log.debug(`Using StataToken for ${symbol}: ${stataAddress} (source: ${source})`);

      const stata = new ethers.Contract(stataAddress, STATATOKEN_ABI, provider);

      // Verify underlying matches
      try {
        const underlyingCheck = await stata.underlying();
        if (underlyingCheck.toLowerCase() !== token.address.toLowerCase()) {
          log.debug(`StataToken for ${symbol} has mismatched underlying`);
          continue;
        }
      } catch (err) {
        log.debug(`StataToken for ${symbol} failed underlying check`);
        continue;
      }

      const testAmount = ethers.utils.parseUnits('1', token.decimals);
      const sharesForDeposit = await stata.previewDeposit(testAmount);
      const assetsForRedeem = await stata.previewRedeem(sharesForDeposit);

      const depositValue = Number(ethers.utils.formatUnits(testAmount, token.decimals));
      const redeemValue = Number(ethers.utils.formatUnits(assetsForRedeem, token.decimals));

      const grossProfit = redeemValue - depositValue;
      const grossProfitUsd = grossProfit * getTokenPriceUsd(token);

      if (grossProfitUsd > 0.01) {
        const maxWithdraw = await stata.maxWithdraw(executionWallet.address);
        if (maxWithdraw.lt(testAmount)) {
          log.debug(`Withdrawal limit too low for ${symbol}`, {
            maxWithdraw: maxWithdraw.toString(),
            testAmount: testAmount.toString(),
          });
          continue;
        }

        const estimatedGasUsd = 0.05 * nativePriceUsd;
        const netProfitUsd = grossProfitUsd - estimatedGasUsd;

        if (netProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
          const candidate: OpportunityCandidate = {
            id: `vault-${symbol}-${Date.now()}`,
            strategy: 'vaultArb',
            protocol: 'stata',
            params: {
              underlying: token,
              stataAddress: stataAddress,
              testAmount: testAmount.toString(),
              depositValue: depositValue,
              redeemValue: redeemValue,
              grossProfitUsd: grossProfitUsd,
              nativePriceUsd,
            },
            estimatedGrossProfitUsd: grossProfitUsd,
            estimatedNetProfitUsd: netProfitUsd,
            estimatedCostUsd: grossProfitUsd - netProfitUsd,
            actionPlan: null,
            sourceTimestamp: Date.now(),
          };

          pushCandidate(candidate);
          candidates.push(candidate);
          log.info(`Found vault arbitrage for ${symbol}`, {
            grossProfitUsd: grossProfitUsd.toFixed(4),
            netProfitUsd: netProfitUsd.toFixed(4),
            stataAddress: stataAddress,
          });
        } else {
          log.debug(`Net profit below threshold for ${symbol}`, {
            netProfitUsd: netProfitUsd.toFixed(6),
            threshold: env.DEFAULT_MIN_PROFIT_USD
          });
        }
      } else {
        log.debug(`No profitable gross profit for ${symbol}`, { grossProfitUsd: grossProfitUsd.toFixed(6) });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('revert') || errorMsg.includes('CALL_EXCEPTION')) {
        log.debug(`StataToken check failed for ${token.symbol}`, { error: errorMsg });
      } else {
        log.debug(`Vault check failed for ${token.symbol}`, { error: errorMsg });
      }
    }
  }

  if (candidates.length === 0) {
    log.info('📭 Vault Arbitrage found 0 candidates this cycle');
  } else {
    log.info(`📦 Vault Arbitrage found ${candidates.length} candidates`);
  }
  return candidates;
}
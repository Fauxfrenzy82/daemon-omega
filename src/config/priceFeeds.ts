import { ethers } from 'ethers';
import { provider } from '../treasury/wallets';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';

const log = createLogger('priceFeeds');

// Chainlink POL/USD feed on Polygon
const CHAINLINK_POL_USD = '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0';

const POL_USD_ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() external view returns (uint8)',
];

let cachedNativePrice: number | null = null;
let cachedNativePriceTimestamp = 0;
const CACHE_TTL_MS = 60000; // 1 minute

export async function fetchNativePriceUsd(): Promise<number> {
  const now = Date.now();
  if (cachedNativePrice !== null && now - cachedNativePriceTimestamp < CACHE_TTL_MS) {
    return cachedNativePrice;
  }

  try {
    const feed = new ethers.Contract(CHAINLINK_POL_USD, POL_USD_ABI, provider);
    const roundData = await withRetry(
      () => feed.latestRoundData(),
      { label: 'priceFeeds.polUsd', shouldRetry: isTransientError, retries: 2 }
    );
    const decimals = await feed.decimals();
    const price = Number(roundData.answer) / 10 ** decimals;

    if (price <= 0) {
      throw new Error(`Invalid price from Chainlink: ${price}`);
    }

    cachedNativePrice = price;
    cachedNativePriceTimestamp = now;
    log.debug('Native price updated', { price });
    return price;
  } catch (error) {
    log.warn('Failed to fetch native price from Chainlink, using fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Last resort fallback — but log warning so it's visible
    return 0.5;
  }
}

export function getCachedNativePrice(): number | null {
  return cachedNativePrice;
}
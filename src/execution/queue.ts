import { getLiveTokenPriceUsd } from '../utils/priceUtils';
import { withRetry, isTransientError } from '../utils/retry';

// Aave V3 Pool address (already used elsewhere)
const AAVE_POOL_ADDRESS = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const AAVE_POOL_ABI = [
  'function getReserveData(address asset) external view returns (uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury)',
];
const ERC20_ABI = ['function totalSupply() view returns (uint256)'];

async function getAvailableFlashLoanLiquidity(token: TokenInfo): Promise<{ availableUsd: number; availableRaw: ethers.BigNumber }> {
  const pool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);
  const reserveData = await withRetry(
    () => pool.getReserveData(token.address),
    { label: `queue.liquidity.${token.symbol}`, shouldRetry: isTransientError, retries: 2 }
  );
  const aTokenAddress = reserveData.aTokenAddress;
  const variableDebtAddress = reserveData.variableDebtTokenAddress;

  const aToken = new ethers.Contract(aTokenAddress, ERC20_ABI, provider);
  const debtToken = new ethers.Contract(variableDebtAddress, ERC20_ABI, provider);

  const [aTotalSupply, debtTotalSupply] = await Promise.all([
    aToken.totalSupply(),
    debtToken.totalSupply(),
  ]);

  const availableRaw = aTotalSupply.sub(debtTotalSupply);
  const priceUsd = await getLiveTokenPriceUsd(token);
  const availableUsd = Number(ethers.utils.formatUnits(availableRaw, token.decimals)) * priceUsd;
  return { availableUsd, availableRaw };
}
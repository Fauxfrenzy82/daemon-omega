import { ethers } from 'ethers';
import { enabledPairs, PairConfig } from '../config/pairs';
import { TokenInfo } from '../config/tokens';
// import { uniswapV3Source } from './sources/uniswapV3'; // REMOVED — address issue; keep for debugging only
import { paraswapV5Source } from './sources/paraswapV5';
import { openOceanV2Source } from './sources/openOceanV2';
import { PriceSource, QuoteResult } from './priceSource';
import { findBestSpread } from './spreadCalculator';
import { evaluateOpportunity, EvaluatedOpportunity } from '../profitability/evaluator';
import { processOpportunityBatch } from '../execution/queue';
import { hasExecutionCapacity } from '../execution/concurrency';
import { evaluateCircuitBreaker, isBreakerTripped } from '../risk/circuitBreaker';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { recordScanCycle } from '../utils/healthServer';

const log = createLogger('scanLoop');

// Use only ParaSwap and OpenOcean for now; Uniswap V3 address issue needs fixing separately.
const SOURCES: PriceSource[] = [paraswapV5Source, openOceanV2Source];
// ... rest unchanged
// src/config/protocolDiscovery.ts

import { createLogger } from '../utils/logger';
import { discoverGammaPools, discoverPoolsOnChain } from './farmDiscovery';
import { registerMerklPools } from '../strategies/classicIncentive/protocolRegistry';

const log = createLogger('protocolDiscovery');

/**
 * Run discovery: only fetch pools, do NOT claim they are harvestable.
 * This is Stage 1 – pool discovery.
 */
export async function discoverAllProtocols(): Promise<void> {
  log.info('🚀 Running protocol discovery...');

  // 1. Discover pools from subgraph
  let pools = await discoverGammaPools();

  if (pools.length === 0) {
    log.info('No pools from subgraph, trying on-chain...');
    const onChainPools = await discoverPoolsOnChain();
    // Convert to expected format
    const converted = onChainPools.map(p => ({
      id: p.id,
      token0: p.token0,
      token1: p.token1,
      totalValueLockedUSD: p.totalValueLockedUSD || '0',
    }));
    registerMerklPools(converted);
    log.info(`✅ Registered ${converted.length} Merkl pools for later incentive checking`);
    return;
  }

  // 2. Register pools (not yet checked for Merkl incentives)
  registerMerklPools(pools);
  log.info(`✅ Registered ${pools.length} Merkl pools – will check claimable rewards in scan cycle`);
  log.info('✅ Protocol discovery complete');
}
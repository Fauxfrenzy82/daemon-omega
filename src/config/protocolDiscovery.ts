// src/config/protocolDiscovery.ts

import { ethers } from 'ethers';
import { createLogger } from '../utils/logger';
import { env } from './env';
import { discoverGammaPools, discoverPoolsOnChain, SubgraphPool, SimplePool } from './farmDiscovery';
import { setMerklProtocols } from '../strategies/classicIncentive/protocolRegistry';

const log = createLogger('protocolDiscovery');

/**
 * Run all discovery services once at startup
 * Sets Merkl/Gamma protocols in the registry
 */
export async function discoverAllProtocols(): Promise<void> {
  log.info('🚀 Running protocol discovery...');

  // 1. Discover Gamma/Merkl pools from subgraph
  let pools: SubgraphPool[] = await discoverGammaPools();

  // 2. If subgraph fails, try on-chain
  if (pools.length === 0) {
    log.info('No pools from subgraph, trying on-chain...');
    const onChainPools = await discoverPoolsOnChain();
    // Convert SimplePool[] to the format expected by setMerklProtocols
    const convertedPools = onChainPools.map(p => ({
      id: p.id,
      token0: p.token0,
      token1: p.token1,
      totalValueLockedUSD: p.totalValueLockedUSD || '0',
    }));
    setMerklProtocols(convertedPools);
    log.info(`✅ Registered ${convertedPools.length} Merkl/Gamma protocols from on-chain`);
    return;
  }

  // 3. Register Merkl/Gamma protocols from subgraph
  if (pools.length > 0) {
    setMerklProtocols(pools);
    log.info(`✅ Registered ${pools.length} Merkl/Gamma protocols from subgraph`);
  } else {
    log.warn('⚠️ No Merkl/Gamma protocols discovered');
  }

  log.info('✅ Protocol discovery complete');
}
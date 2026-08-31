// src/config/protocolDiscovery.ts

import { ethers } from 'ethers';
import { createLogger } from '../utils/logger';
import { env } from './env';
import { discoverGammaPools, discoverPoolsOnChain } from './farmDiscovery';
import { setMerklProtocols } from '../strategies/classicIncentive/protocolRegistry';

const log = createLogger('protocolDiscovery');

/**
 * Run all discovery services once at startup
 * Sets Merkl/Gamma protocols in the registry
 */
export async function discoverAllProtocols(): Promise<void> {
  log.info('🚀 Running protocol discovery...');

  // 1. Discover Gamma/Merkl pools from subgraph
  let pools = await discoverGammaPools();

  if (pools.length === 0) {
    log.info('No pools from subgraph, trying on-chain...');
    const onChainPools = await discoverPoolsOnChain();
    pools = onChainPools.map(p => ({
      id: p.id,
      token0: p.token0,
      token1: p.token1,
      totalValueLockedUSD: '0',
    }));
  }

  // 2. Register Merkl/Gamma protocols
  if (pools.length > 0) {
    setMerklProtocols(pools);
    log.info(`✅ Registered ${pools.length} Merkl/Gamma protocols`);
  } else {
    log.warn('⚠️ No Merkl/Gamma protocols discovered');
  }

  log.info('✅ Protocol discovery complete');
}
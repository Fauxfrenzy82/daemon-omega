// Add to protocolRegistry.ts

import { DiscoveredProtocol } from '../../config/protocolDiscovery';

// Store discovered protocols
let discoveredProtocols: ProtocolConfig[] = [];

/**
 * Set discovered protocols from self-discovery
 * Called once at startup from main.ts
 */
export function setDiscoveredProtocols(discovered: DiscoveredProtocol[]): void {
  discoveredProtocols = discovered.map(d => ({
    id: d.id,
    name: d.name,
    priority: d.priority,
    address: d.address,
    functions: d.functionNames.map(name => ({ name, signature: `${name}()` })),
    rewardToken: d.rewardToken,
    entryToken: d.entryToken,
    rewardType: 'harvest-triggered' as RewardType,
    skipForCallerHarvest: false,
    abi: [], // Will be resolved dynamically
  }));

  log.info(`✅ Registered ${discoveredProtocols.length} discovered protocols`);
}

/**
 * Get all protocols (hardcoded + discovered)
 */
export function getAllProtocols(): ProtocolConfig[] {
  return [...HARVESTABLE_PROTOCOLS, ...discoveredProtocols];
}

// Update getHarvestableProtocols to include discovered ones
export function getHarvestableProtocols(): ProtocolConfig[] {
  const all = getAllProtocols();
  return all.filter(p => !p.skipForCallerHarvest);
}
import * as api from '@protocolink/api';
import * as common from '@protocolink/common';
import { activeChain } from '../config/chains';
import { executionWallet } from '../treasury/wallets';
import { createLogger } from '../utils/logger';

const log = createLogger('protocolinkClient');

let initialized = false;

export function initProtocolink(): void {
  if (initialized) return;
  initialized = true;
  log.info('Protocolink client initialized', { chainId: activeChain.chainId });
}

export function getChainId(): number {
  return activeChain.chainId;
}

export function getAgentAddress(): Promise<string> {
  return api.getAgent(activeChain.chainId, executionWallet.address);
}

export async function getPermit2Status(tokenAddress: string): Promise<boolean> {
  try {
    const allowance = await api.protocols.permit2.getAllowance(
      activeChain.chainId,
      executionWallet.address,
      tokenAddress
    );
    return allowance !== undefined && allowance !== '0';
  } catch (err) {
    log.warn('Failed to check Permit2 allowance', {
      tokenAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export { api, common };
import * as api from '@protocolink/api';
import axios from 'axios';
import { activeChain } from '../config/chains';
import { executionWallet } from '../treasury/wallets';
import { createLogger } from '../utils/logger';

const log = createLogger('protocolinkClient');

let initialized = false;
let interceptorsAttached = false;

function attachDiagnosticInterceptors(): void {
  if (interceptorsAttached) return;
  interceptorsAttached = true;

  axios.interceptors.request.use(
    (config) => {
      log.info('🌐 OUTBOUND HTTP REQUEST', {
        method: config.method?.toUpperCase(),
        url: config.url,
        params: config.params ? JSON.stringify(config.params) : undefined,
        data: config.data ? JSON.stringify(config.data) : undefined,
      });
      return config;
    },
    (error) => {
      log.error('🌐 OUTBOUND HTTP REQUEST SETUP FAILED', {
        error: error?.message || String(error),
      });
      return Promise.reject(error);
    }
  );

  axios.interceptors.response.use(
    (response) => {
      log.info('🌐 INBOUND HTTP RESPONSE', {
        status: response.status,
        url: response.config?.url,
        data: JSON.stringify(response.data),
      });
      return response;
    },
    (error) => {
      log.error('🌐 INBOUND HTTP ERROR RESPONSE', {
        status: error?.response?.status,
        url: error?.config?.url,
        responseData: JSON.stringify(error?.response?.data),
      });
      return Promise.reject(error);
    }
  );

  log.info('Diagnostic HTTP interceptors attached');
}

export function initProtocolink(): void {
  if (initialized) return;
  attachDiagnosticInterceptors();
  initialized = true;
  log.info('Protocolink client initialized', { chainId: activeChain.chainId });
}

export function getChainId(): number {
  return activeChain.chainId;
}

export async function getAgentAddress(): Promise<string> {
  return executionWallet.address;
}

export { api };
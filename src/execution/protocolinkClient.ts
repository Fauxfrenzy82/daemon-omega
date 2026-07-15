import * as api from '@protocolink/api';
import axios from 'axios';
import { activeChain } from '../config/chains';
import { executionWallet } from '../treasury/wallets';
import { createLogger } from '../utils/logger';

const log = createLogger('protocolinkClient');

let initialized = false;
let interceptorsAttached = false;

/**
 * Attaches global axios interceptors BEFORE any Protocolink SDK calls
 * happen, to log the exact outbound request (method, full URL, full
 * body) and exact inbound response for every HTTP call — including
 * ones made internally by @protocolink/api that we never construct
 * ourselves. This is diagnostic-only: it doesn't change behavior, it
 * only logs.
 */
function attachDiagnosticInterceptors(): void {
  if (interceptorsAttached) return;
  interceptorsAttached = true;

  axios.interceptors.request.use(
    (config) => {
      log.info('🌐 OUTBOUND HTTP REQUEST', {
        method: config.method?.toUpperCase(),
        url: config.url,
        baseURL: config.baseURL,
        fullUrl: config.baseURL ? `${config.baseURL}${config.url}` : config.url,
        params: config.params ? JSON.stringify(config.params) : undefined,
        data: config.data ? JSON.stringify(config.data) : undefined,
        headers: config.headers ? JSON.stringify(config.headers) : undefined,
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
        fullUrl: response.config?.baseURL
          ? `${response.config.baseURL}${response.config.url}`
          : response.config?.url,
        data: JSON.stringify(response.data),
        headers: response.headers,
      });
      return response;
    },
    (error) => {
      log.error('🌐 INBOUND HTTP ERROR RESPONSE', {
        status: error?.response?.status,
        url: error?.config?.url,
        fullUrl: error?.config?.baseURL
          ? `${error.config.baseURL}${error.config.url}`
          : error?.config?.url,
        requestData: error?.config?.data ? JSON.stringify(error.config.data) : undefined,
        requestParams: error?.config?.params ? JSON.stringify(error.config.params) : undefined,
        responseData: JSON.stringify(error?.response?.data),
        headers: error?.response?.headers,
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
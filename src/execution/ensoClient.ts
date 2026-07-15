import { EnsoClient } from '@ensofinance/sdk';
import { env } from '../config/env';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import axios from 'axios';

const log = createLogger('ensoClient');

let ensoClient: EnsoClient | null = null;
let interceptorsAttached = false;

/**
 * Attach axios interceptors to log every Enso API request/response.
 * This is critical for debugging – you'll see the exact URL and payload.
 */
function attachDiagnosticInterceptors(): void {
  if (interceptorsAttached) return;
  interceptorsAttached = true;

  axios.interceptors.request.use(
    (config) => {
      log.info('🌐 ENSO OUTBOUND REQUEST', {
        method: config.method?.toUpperCase(),
        url: config.url,
        baseURL: config.baseURL,
        fullUrl: config.baseURL ? `${config.baseURL}${config.url}` : config.url,
        params: config.params,
        data: config.data ? JSON.stringify(config.data) : undefined,
        headers: config.headers,
      });
      return config;
    },
    (error) => {
      log.error('🌐 ENSO REQUEST SETUP FAILED', { error: String(error) });
      return Promise.reject(error);
    }
  );

  axios.interceptors.response.use(
    (response) => {
      log.info('🌐 ENSO RESPONSE', {
        status: response.status,
        url: response.config?.url,
        data: JSON.stringify(response.data),
      });
      return response;
    },
    (error) => {
      log.error('🌐 ENSO ERROR RESPONSE', {
        status: error?.response?.status,
        url: error?.config?.url,
        data: error?.response?.data ? JSON.stringify(error.response.data) : undefined,
        message: error?.message,
      });
      return Promise.reject(error);
    }
  );

  log.info('Enso HTTP interceptors attached');
}

export function initEnsoClient(): EnsoClient {
  if (!ensoClient) {
    if (!env.ENSO_API_KEY) {
      throw new Error(
        'ENSO_API_KEY is required. Get one from https://developers.enso.build'
      );
    }
    // ✅ FIX: Use api.enso.build (not api.enso.finance)
    // The SDK will append /api/v1/shortcuts/bundle automatically
    attachDiagnosticInterceptors();
    ensoClient = new EnsoClient({
      apiKey: env.ENSO_API_KEY,
      baseURL: 'https://api.enso.build', // ✅ correct base URL
    });
    log.info('Enso client initialized', { chainId: activeChain.chainId });
  }
  return ensoClient;
}

export function getEnsoClient(): EnsoClient {
  if (!ensoClient) {
    throw new Error('Enso client not initialized. Call initEnsoClient() first.');
  }
  return ensoClient;
}
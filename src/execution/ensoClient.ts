import { EnsoClient } from '@ensofinance/sdk';
import { env } from '../config/env';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import axios from 'axios';

const log = createLogger('ensoClient');

let ensoClient: EnsoClient | null = null;
let interceptorsAttached = false;

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
        'ENSO_API_KEY is required. Get one from https://developers.enso.finance'
      );
    }
    attachDiagnosticInterceptors();

    // No custom baseURL passed — every official Enso example
    // (docs.enso.build, GitHub README, npm page) constructs
    // EnsoClient with only { apiKey }. The prior attempt of manually
    // supplying baseURL (first api.enso.build, then corrected to
    // api.enso.finance) caused the SDK to skip its own internal
    // /api/v1 path prefix entirely — visible in the last log as a
    // request to the bare /shortcuts/bundle path with params
    // serialized as a query string instead of a JSON body, a strong
    // sign the custom baseURL bypassed the SDK's normal internal
    // request construction. Letting the SDK use its own default
    // should restore the correct path and POST-body behavior.
    ensoClient = new EnsoClient({
      apiKey: env.ENSO_API_KEY,
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
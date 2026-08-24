import { EnsoClient } from '@ensofinance/sdk';
import { env } from '../config/env';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import axios from 'axios';

const log = createLogger('ensoClient');

let ensoClient: EnsoClient | null = null;
let interceptorsAttached = false;

/**
 * ✅ FIXED: Only attach interceptors to Enso's axios instance.
 * 
 * This uses a simple approach: we wrap the Enso client methods directly.
 * No global interceptors that would capture Discord webhook requests.
 */
function attachDiagnosticInterceptors(): void {
  if (interceptorsAttached) return;
  interceptorsAttached = true;

  // ✅ Don't attach global interceptors – they capture non-Enso traffic
  log.info('Enso client logging enabled (no global interceptors)');
}

/**
 * ✅ Wrapper around EnsoClient that logs only Enso requests.
 * This avoids capturing Discord webhook or other third-party traffic.
 */
class LoggingEnsoClient {
  private client: EnsoClient;

  constructor(client: EnsoClient) {
    this.client = client;
  }

  async getBundleData(params: any, actions: any): Promise<any> {
    try {
      // ✅ Log only Enso-specific information
      log.info('🌐 ENSO BUNDLE REQUEST', {
        actionCount: actions?.length,
        hasParams: !!params,
      });
      const result = await this.client.getBundleData(params, actions);
      log.info('🌐 ENSO BUNDLE RESPONSE', {
        hasTx: !!(result as any)?.tx,
        hasSimulation: !!(result as any)?.simulation,
      });
      return result;
    } catch (error: any) {
      log.error('🌐 ENSO BUNDLE ERROR', {
        message: error?.message,
        statusCode: error?.statusCode || error?.response?.status,
        // ✅ Don't log full responseData – may contain sensitive info
      });
      throw error;
    }
  }

  async getRouteData(params: any): Promise<any> {
    try {
      // ✅ Log only Enso-specific information
      log.info('🌐 ENSO ROUTE REQUEST', {
        tokenIn: params?.tokenIn?.[0],
        tokenOut: params?.tokenOut?.[0],
        amountIn: params?.amountIn?.[0],
      });
      const result = await this.client.getRouteData(params);
      log.info('🌐 ENSO ROUTE RESPONSE', {
        hasAmountOut: !!(result as any)?.amountOut,
        hasRoute: !!(result as any)?.route,
      });
      return result;
    } catch (error: any) {
      log.error('🌐 ENSO ROUTE ERROR', {
        message: error?.message,
        statusCode: error?.statusCode || error?.response?.status,
      });
      throw error;
    }
  }
}

export function initEnsoClient(): EnsoClient {
  if (!ensoClient) {
    if (!env.ENSO_API_KEY) {
      throw new Error(
        'ENSO_API_KEY is required. Get one from https://developers.enso.finance'
      );
    }

    // ✅ Create the client
    ensoClient = new EnsoClient({
      apiKey: env.ENSO_API_KEY,
    });

    // ✅ Wrap the client for logging (doesn't affect other HTTP traffic)
    const wrappedClient = new LoggingEnsoClient(ensoClient);
    (ensoClient as any)._wrapped = wrappedClient;

    log.info('Enso client initialized', { chainId: activeChain.chainId });
  }
  return ensoClient;
}

export function getEnsoClient(): EnsoClient {
  if (!ensoClient) {
    throw new Error('Enso client not initialized. Call initEnsoClient() first.');
  }
  // Return the wrapped client if available
  if ((ensoClient as any)._wrapped) {
    return (ensoClient as any)._wrapped as EnsoClient;
  }
  return ensoClient;
}

export function getEnsoClientWrapper(): LoggingEnsoClient {
  const client = getEnsoClient();
  if (!(client as any)._wrapped) {
    return new LoggingEnsoClient(client);
  }
  return (client as any)._wrapped;
}
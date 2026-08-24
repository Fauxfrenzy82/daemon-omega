import { EnsoClient } from '@ensofinance/sdk';
import { env } from '../config/env';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import axios from 'axios';

const log = createLogger('ensoClient');

let ensoClient: EnsoClient | null = null;
let interceptorsAttached = false;

/**
 * ✅ FIX: Only attach interceptors to Enso's axios instance, not global axios.
 * This prevents Discord webhook and other non-Enso requests from being logged.
 */
function attachDiagnosticInterceptors(): void {
  if (interceptorsAttached) return;
  interceptorsAttached = true;

  // ✅ Get the axios instance used by EnsoClient
  // Since we can't directly access EnsoClient's internal axios instance,
  // we check if we can configure it via the client options.
  // For now, we'll use a different approach: we don't attach global interceptors.
  // Instead, we rely on the EnsoClient's built-in logging if available.
  // If EnsoClient doesn't support built-in logging, we'll create a wrapper.

  // ✅ Safer approach: Create a wrapper around EnsoClient that logs only Enso requests
  // This avoids the global axios interceptors entirely.

  log.info('Enso client will use request/response logging via wrapper (not global interceptors)');
}

// ✅ Custom wrapper class to log only Enso requests
class LoggingEnsoClient {
  private client: EnsoClient;

  constructor(client: EnsoClient) {
    this.client = client;
  }

  async getBundleData(params: any, actions: any): Promise<any> {
    try {
      log.info('🌐 ENSO BUNDLE REQUEST', {
        params: JSON.stringify(params),
        actions: JSON.stringify(actions),
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
        responseData: error?.responseData || error?.response?.data,
      });
      throw error;
    }
  }

  async getRouteData(params: any): Promise<any> {
    try {
      log.info('🌐 ENSO ROUTE REQUEST', {
        params: JSON.stringify(params),
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
        responseData: error?.responseData || error?.response?.data,
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

    // Create the client without global interceptors
    ensoClient = new EnsoClient({
      apiKey: env.ENSO_API_KEY,
    });

    // ✅ Wrap the client for logging (doesn't affect other HTTP traffic)
    const wrappedClient = new LoggingEnsoClient(ensoClient);

    // Store the wrapped client
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

// ✅ Export the logging wrapper for direct use
export function getEnsoClientWrapper(): LoggingEnsoClient {
  const client = getEnsoClient();
  if (!(client as any)._wrapped) {
    return new LoggingEnsoClient(client);
  }
  return (client as any)._wrapped;
}
import { EnsoClient } from '@ensofinance/sdk';
import { env } from '../config/env';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import axios from 'axios';

const log = createLogger('ensoClient');

let ensoClient: EnsoClient | null = null;
let interceptorsAttached = false;

/**
 * Attach diagnostic interceptors to Enso's axios instance.
 */
function attachDiagnosticInterceptors(): void {
  if (interceptorsAttached) return;
  interceptorsAttached = true;
  log.info('Enso client logging enabled');
}

/**
 * Wrapper around EnsoClient that logs all Enso requests.
 */
class LoggingEnsoClient {
  private client: EnsoClient;

  constructor(client: EnsoClient) {
    this.client = client;
  }

  async getBundleData(params: any, actions: any): Promise<any> {
    try {
      // 🔍 DEBUG: Log the FULL payload being sent to Enso
      const payload = { params, actions };
      log.info('🔍 ENSO BUNDLE PAYLOAD (DEBUG)', {
        payloadJSON: JSON.stringify(payload, (key, value) => {
          if (typeof value === 'bigint') return value.toString();
          // Truncate large arrays for readability but keep structure
          if (Array.isArray(value) && value.length > 10) {
            return `[${value.length} items]`;
          }
          return value;
        }, 2)
      });

      // 🔍 DEBUG: Specifically log the flashloan action structure
      if (actions && Array.isArray(actions)) {
        for (let i = 0; i < actions.length; i++) {
          const action = actions[i];
          if (action?.action === 'flashloan') {
            log.info('🔍 FLASHLOAN ACTION STRUCTURE:', {
              index: i,
              protocol: action.protocol,
              action: action.action,
              hasTokenInRoot: !!action.tokenIn,
              hasAmountInRoot: !!action.amountIn,
              tokenInValue: action.tokenIn,
              amountInValue: action.amountIn,
              hasTokenInArgs: !!(action.args?.tokenIn),
              hasAmountInArgs: !!(action.args?.amountIn),
              argsKeys: action.args ? Object.keys(action.args) : [],
              // Show if tokenIn is nested inside args (WRONG)
              tokenInNested: !!(action.args?.tokenIn),
              amountInNested: !!(action.args?.amountIn),
            });
          }
        }
      }

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
        responseData: error?.responseData || error?.response?.data,
      });
      throw error;
    }
  }

  async getRouteData(params: any): Promise<any> {
    try {
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

    // Create the client
    ensoClient = new EnsoClient({
      apiKey: env.ENSO_API_KEY,
    });

    // Wrap the client for logging
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
import { AsyncLocalStorage } from 'node:async_hooks';
import type { MarketSharpCredentials } from './types.js';

/**
 * Request-scoped credentials. Gateway mode runs each HTTP request inside
 * runWithCredentials(). Kept in its own module so the logger can redact the
 * credentials in scope without importing the client.
 */
const credStore = new AsyncLocalStorage<MarketSharpCredentials>();

export function runWithCredentials<T>(creds: MarketSharpCredentials, fn: () => T): T {
  return credStore.run(creds, fn);
}

export function scopedCredentials(): MarketSharpCredentials | undefined {
  return credStore.getStore();
}

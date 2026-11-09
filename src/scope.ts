import { AsyncLocalStorage } from 'node:async_hooks';
import type { MarketSharpCredentials } from './types.js';

/**
 * Request scope. The HTTP server runs every /mcp request inside
 * runInRequestScope(): gateway mode passes that request's credentials, and
 * both modes pass a signal that aborts when the gateway client disconnects.
 * The access tokens used in the scope are remembered so the logger can
 * redact them by exact match whatever their shape. Kept in its own module so
 * the logger can read it without importing the client.
 */
interface RequestScope {
  creds?: MarketSharpCredentials;
  signal?: AbortSignal;
  tokens: Set<string>;
}

const store = new AsyncLocalStorage<RequestScope>();

export function runInRequestScope<T>(scope: { creds?: MarketSharpCredentials; signal?: AbortSignal }, fn: () => T): T {
  return store.run({ ...scope, tokens: new Set() }, fn);
}

export function runWithCredentials<T>(creds: MarketSharpCredentials, fn: () => T): T {
  return runInRequestScope({ creds }, fn);
}

export function scopedCredentials(): MarketSharpCredentials | undefined {
  return store.getStore()?.creds;
}

/** Aborts when the caller of this request has gone away. Undefined outside an HTTP request (stdio). */
export function callerSignal(): AbortSignal | undefined {
  return store.getStore()?.signal;
}

/** No-op outside a request scope; stdio relies on the token-shape patterns. */
export function rememberToken(token: string): void {
  store.getStore()?.tokens.add(token);
}

export function scopedTokens(): string[] {
  return [...(store.getStore()?.tokens ?? [])];
}

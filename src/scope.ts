import { AsyncLocalStorage } from 'node:async_hooks';
import type { MarketSharpCredentials } from './types.js';

/**
 * Request scope. The HTTP server runs every /mcp request inside
 * runInRequestScope(): gateway mode passes that request's credentials, and
 * both modes pass a signal that aborts when the gateway client disconnects.
 * The access tokens used in the scope are remembered so the logger can
 * redact them by exact match whatever their shape. Kept in its own module so
 * the logger can read it without importing the client.
 *
 * The scope also counts the request's in-flight upstream calls, so a JSON-RPC
 * batch of tool calls can't fan out into one MarketSharp call per message.
 */
interface RequestScope {
  creds?: MarketSharpCredentials;
  signal?: AbortSignal;
  tokens: Set<string>;
  /** Upstream calls running now, and the callers queued for a free slot (oldest first). */
  active: number;
  waiting: Array<() => void>;
}

/** Most upstream MarketSharp calls one request may have in flight. */
export const MAX_CONCURRENT_UPSTREAM = 4;

const store = new AsyncLocalStorage<RequestScope>();

export function runInRequestScope<T>(scope: { creds?: MarketSharpCredentials; signal?: AbortSignal }, fn: () => T): T {
  return store.run({ ...scope, tokens: new Set(), active: 0, waiting: [] }, fn);
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

/**
 * Runs `fn` once this request has fewer than MAX_CONCURRENT_UPSTREAM upstream
 * calls in flight. Waiting ends with the signal's reason if the caller goes
 * away. Outside a request scope (stdio) there is no limit.
 */
export async function withUpstreamSlot<T>(fn: () => Promise<T>): Promise<T> {
  const scope = store.getStore();
  if (!scope) return fn();
  const { signal } = scope;
  signal?.throwIfAborted();
  if (scope.active < MAX_CONCURRENT_UPSTREAM) {
    scope.active++;
  } else {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        scope.waiting.splice(scope.waiting.indexOf(wake), 1);
        reject(signal?.reason);
      };
      // A releasing call hands its slot straight to the next waiter, so `active` stays put.
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      scope.waiting.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  try {
    return await fn();
  } finally {
    const next = scope.waiting.shift();
    if (next) next();
    else scope.active--;
  }
}

import { MarketSharpApiError } from '../client.js';

export type Args = Record<string, unknown>;

export function optString(args: Args, key: string, max = 500): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw new MarketSharpApiError(`${key} must be a string.`);
  }
  const s = String(v).trim();
  if (!s) return undefined;
  if (s.length > max) throw new MarketSharpApiError(`${key} is too long (max ${max} characters).`);
  return s;
}

export function reqString(args: Args, key: string, max = 500): string {
  const s = optString(args, key, max);
  if (s === undefined) throw new MarketSharpApiError(`${key} is required.`);
  return s;
}

export function optInt(args: Args, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new MarketSharpApiError(`${key} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

export function optBool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new MarketSharpApiError(`${key} must be true or false.`);
}

export function optEnum<T extends string>(args: Args, key: string, allowed: readonly T[]): T | undefined {
  const s = optString(args, key, 100);
  if (s === undefined) return undefined;
  const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
  if (!hit) throw new MarketSharpApiError(`${key} must be one of: ${allowed.join(', ')}.`);
  return hit;
}

export function optStringArray(args: Args, key: string, maxItems = 100): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' && typeof x !== 'number')) {
    throw new MarketSharpApiError(`${key} must be a list of ids.`);
  }
  if (v.length > maxItems) throw new MarketSharpApiError(`${key} can have at most ${maxItems} items.`);
  const out = v.map((x) => String(x).trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/** Drop undefined values so MarketSharp never receives explicit nulls we didn't mean to send. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

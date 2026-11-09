/**
 * Every request a tool builds is checked against the MarketSharp v2 swagger
 * (a trimmed, vendored copy in fixtures/). The method and path must match a
 * spec route and every query parameter must be one that route declares. POST
 * bodies are also checked against the route's request model: a key the model
 * doesn't declare, a missing required key, a value outside an enum or a wrong
 * JSON type fails here instead of at MarketSharp. Each tool is built with
 * every argument filled, with each optional argument alone, with each boolean
 * false and with each enum value, so every path variant and key is covered.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MarketSharpRequest } from '../client.js';
import { TOOLS, type ToolDef } from '../tools/index.js';

interface Model {
  operationId: string;
  /** POST only: the request-body model. */
  model?: string;
  required?: string[];
  properties?: Record<string, { type: string; enum?: unknown[] }>;
  query: Record<string, { type: string }>;
}
const SPEC = JSON.parse(readFileSync(new URL('./fixtures/marketsharp-request-models.json', import.meta.url), 'utf8')) as {
  endpoints: Record<string, Model>;
};

const creds = { companyId: '123', apiKey: 'k', apiSecret: 's', employeeId: '9' };

type Prop = { type?: string; enum?: unknown[]; minimum?: number };
function sample(p: Prop): unknown {
  if (p.enum) return p.enum[0];
  if (p.type === 'integer') return p.minimum ?? 1;
  if (p.type === 'boolean') return true;
  if (p.type === 'array') return ['x'];
  return 'x';
}

/** The matching route with the most literal characters, so /inquiries/statuses beats /inquiries/{inquiryId}. */
function modelFor(method: string, path: string): Model | undefined {
  let best: { model: Model; literal: number } | undefined;
  for (const [key, model] of Object.entries(SPEC.endpoints)) {
    const [m, template] = key.split(' ');
    if (m !== method || !new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path)) continue;
    const literal = template.replace(/\{[^}]+\}/g, '').length;
    if (!best || literal > best.literal) best = { model, literal };
  }
  return best?.model;
}

const jsonType = (v: unknown) => (Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

/** Argument sets that reach every path variant and key a tool can send. */
function variants(t: ToolDef): Record<string, unknown>[] {
  const props = Object.entries(t.inputSchema.properties) as [string, Prop][];
  const required = new Set(t.inputSchema.required ?? []);
  const base = Object.fromEntries(props.filter(([k]) => required.has(k)).map(([k, p]) => [k, sample(p)]));
  const all = Object.fromEntries(props.map(([k, p]) => [k, sample(p)]));
  const out = [base, all];
  for (const [k, p] of props) {
    if (!required.has(k)) out.push({ ...base, [k]: sample(p) });
    if (p.type === 'boolean') out.push({ ...all, [k]: false });
    for (const v of p.enum ?? []) out.push({ ...all, [k]: v });
  }
  return out;
}

/** Variants that build (a search tool with no search field throws by design). */
function builtRequests(t: ToolDef): MarketSharpRequest[] {
  const out: MarketSharpRequest[] = [];
  for (const args of variants(t)) {
    try {
      out.push(t.build(args, creds));
    } catch {
      // not a sendable request
    }
  }
  return out;
}

const posts = TOOLS.map((t) => {
  const args = Object.fromEntries(Object.entries(t.inputSchema.properties).map(([k, p]) => [k, sample(p as Prop)]));
  return { name: t.name, req: t.build(args, creds) };
}).filter((x) => x.req.method === 'POST');

describe('every request matches a MarketSharp v2 route and its declared query parameters', () => {
  it.each(TOOLS.map((t) => [t.name, t] as const))('%s', (_name, tool) => {
    const requests = builtRequests(tool);
    expect(requests.length, 'no argument set builds a request').toBeGreaterThan(0);
    for (const req of requests) {
      const route = modelFor(req.method, req.path);
      expect(route, `no spec route for ${req.method} ${req.path}`).toBeDefined();
      for (const [key, value] of Object.entries(req.query ?? {})) {
        if (value !== undefined) expect(route!.query, `${req.method} ${req.path} query ${key}`).toHaveProperty(key);
      }
    }
  });
});

describe('POST bodies match the MarketSharp v2 request models', () => {
  it('checks all 8 POST tools', () => {
    expect(posts.map((p) => p.name).sort()).toEqual([
      'marketsharp_appointments_list',
      'marketsharp_contacts_list',
      'marketsharp_contacts_search',
      'marketsharp_inquiries_list',
      'marketsharp_inquiries_search',
      'marketsharp_jobs_search',
      'marketsharp_opportunities_list',
      'marketsharp_search_global',
    ]);
  });

  it.each(posts.map((p) => [p.name, p.req] as const))('%s', (_name, req) => {
    const model = modelFor('POST', req.path);
    expect(model, `no spec model for POST ${req.path}`).toBeDefined();
    const body = req.body as Record<string, unknown>;
    for (const key of model!.required ?? []) expect(body, `${model!.model} requires ${key}`).toHaveProperty(key);
    for (const [key, value] of Object.entries(body)) {
      const prop = model!.properties?.[key];
      expect(prop, `${key} is not a ${model!.model} property`).toBeDefined();
      expect(jsonType(value), `${model!.model}.${key} type`).toBe(prop!.type);
      if (prop!.enum) expect(prop!.enum, `${model!.model}.${key} enum`).toContain(value);
    }
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) expect(model!.query, `query ${key}`).toHaveProperty(key);
    }
  });
});

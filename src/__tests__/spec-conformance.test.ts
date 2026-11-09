/**
 * Every POST body a tool builds is checked against the request models in the
 * MarketSharp v2 swagger (a trimmed, vendored copy in fixtures/). A key the
 * model doesn't declare, a missing required key, a value outside an enum, a
 * wrong JSON type or an undeclared query parameter fails here instead of at
 * MarketSharp. Each tool is built with every argument filled, so every key it
 * can send is checked.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../tools/index.js';

interface Model {
  model: string;
  required: string[];
  properties: Record<string, { type: string; enum?: unknown[] }>;
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

function modelFor(method: string, path: string): Model | undefined {
  for (const [key, model] of Object.entries(SPEC.endpoints)) {
    const [m, template] = key.split(' ');
    if (m === method && new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path)) return model;
  }
  return undefined;
}

const jsonType = (v: unknown) => (Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

const posts = TOOLS.map((t) => {
  const args = Object.fromEntries(Object.entries(t.inputSchema.properties).map(([k, p]) => [k, sample(p as Prop)]));
  return { name: t.name, req: t.build(args, creds) };
}).filter((x) => x.req.method === 'POST');

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
    for (const key of model!.required) expect(body, `${model!.model} requires ${key}`).toHaveProperty(key);
    for (const [key, value] of Object.entries(body)) {
      const prop = model!.properties[key];
      expect(prop, `${key} is not a ${model!.model} property`).toBeDefined();
      expect(jsonType(value), `${model!.model}.${key} type`).toBe(prop.type);
      if (prop.enum) expect(prop.enum, `${model!.model}.${key} enum`).toContain(value);
    }
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) expect(model!.query, `query ${key}`).toHaveProperty(key);
    }
  });
});

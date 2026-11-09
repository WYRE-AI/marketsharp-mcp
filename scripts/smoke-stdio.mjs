#!/usr/bin/env node
// Spawns the built stdio server (dist/index.js) and checks the tool surface
// and input guards. Makes no network call: the only tool calls made here are
// ones the server must refuse before signing in to MarketSharp (a traversal
// id, a hidden write, an unknown tool). Upstream round-trips are covered by
// the mocked tests in src/__tests__.
// Usage: npm run build && npm run smoke
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const FAKE_SECRET = 'smoke-secret-not-real-0000';

const EXPECTED = [
  'marketsharp_activity_types_list',
  'marketsharp_appointment_results_list',
  'marketsharp_appointments_get',
  'marketsharp_appointments_list',
  'marketsharp_appointments_list_by_contact',
  'marketsharp_companies_get',
  'marketsharp_companies_list',
  'marketsharp_contacts_get',
  'marketsharp_contacts_list',
  'marketsharp_contacts_search',
  'marketsharp_divisions_list',
  'marketsharp_employees_list',
  'marketsharp_inquiries_get',
  'marketsharp_inquiries_list',
  'marketsharp_inquiries_list_by_contact',
  'marketsharp_inquiries_search',
  'marketsharp_inquiry_notes_list',
  'marketsharp_inquiry_statuses_list',
  'marketsharp_jobs_get',
  'marketsharp_jobs_search',
  'marketsharp_lead_sources_list',
  'marketsharp_notes_list',
  'marketsharp_opportunities_list',
  'marketsharp_product_interests_list',
  'marketsharp_search_global',
].sort();

function fail(message) {
  console.error(`smoke-stdio: FAIL - ${message}`);
  process.exitCode = 1;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    PATH: process.env.PATH ?? '',
    LOG_LEVEL: 'error',
    MARKETSHARP_COMPANY_ID: '123',
    MARKETSHARP_API_KEY: 'smoke-key-not-real-0000',
    MARKETSHARP_API_SECRET: FAKE_SECRET,
  },
});
const client = new Client({ name: 'smoke', version: '0.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  if (tools.length !== 25) fail(`expected 25 tools, got ${tools.length}`);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED)) fail(`tool names differ: ${names.join(', ')}`);
  if (!tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)) fail('a tool is not annotated read-only');

  const traversal = await client.callTool({ name: 'marketsharp_contacts_get', arguments: { contactId: '../token' } });
  const text = traversal.content?.[0]?.text ?? '';
  if (!traversal.isError || !/contactId/.test(text)) fail(`traversal id was not refused: ${text.slice(0, 200)}`);
  if (text.includes(FAKE_SECRET)) fail('secret leaked into tool output');

  const write = await client.callTool({ name: 'marketsharp_contact_notes_create', arguments: { contactId: 'c1', note: 'x' } });
  if (!write.isError || !/turned off/.test(write.content?.[0]?.text ?? '')) fail('hidden write was not refused');

  const unknown = await client.callTool({ name: 'marketsharp_contacts_delete', arguments: {} });
  if (!unknown.isError) fail('unknown tool did not error');

  if (!process.exitCode) console.log(`smoke-stdio: OK (${tools.length} read-only tools; traversal id, hidden write and unknown tool refused without a network call)`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await client.close().catch(() => {});
}

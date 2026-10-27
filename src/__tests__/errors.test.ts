import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokenCache, getToken, marketsharpRequest, runWithCredentials } from '../client.js';
import { dispatchToolCall } from '../tools/index.js';

const creds = { companyId: '123', apiKey: 'k', apiSecret: 's', employeeId: '9' };
const WRITES_ON = { MARKETSHARP_ENABLE_WRITES: 'true' } as NodeJS.ProcessEnv;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const fetchMock = vi.fn();
beforeEach(() => {
  clearTokenCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/** Token requests succeed; every other request goes through `vendor`. */
const vendorReplies = (vendor: () => Response | Promise<Response>) =>
  fetchMock.mockImplementation(async (url: string) => (String(url).endsWith('/token') ? json({ access_token: 'tk' }) : vendor()));

async function callText(name: string, args: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = WRITES_ON) {
  const result = await runWithCredentials(creds, () => dispatchToolCall(name, args, env));
  expect(result.isError).toBe(true);
  return result.content[0].text;
}

const NOTE = 'marketsharp_contact_notes_create';
const noteArgs = { contactId: 'c1', note: 'hi' };
const READ = 'marketsharp_divisions_list';
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const DUPLICATE_WARNING = 'may already have gone through';

describe('error copy', () => {
  it('names MARKETSHARP_ENABLE_WRITES when a write is turned off', async () => {
    const text = await callText(NOTE, noteArgs, {} as NodeJS.ProcessEnv);
    expect(text).toContain('MARKETSHARP_ENABLE_WRITES=true');
  });

  it('warns that a write that timed out may already have gone through, without raw error text', async () => {
    vendorReplies(() => {
      throw timeoutError();
    });
    const text = await callText(NOTE, noteArgs);
    expect(text).toContain("it didn't respond in time.");
    expect(text).toContain(DUPLICATE_WARNING);
    expect(text).not.toContain('aborted');
  });

  it('warns on a write that gets a 5xx', async () => {
    vendorReplies(() => json({}, 502));
    const text = await callText(NOTE, noteArgs);
    expect(text).toContain('MarketSharp had a problem on its side (HTTP 502)');
    expect(text).toContain(DUPLICATE_WARNING);
  });

  it('says the connection failed for a generic network error, hiding the raw text', async () => {
    vendorReplies(() => {
      throw new Error('ECONNRESET 10.0.0.1:443');
    });
    const text = await callText(READ);
    expect(text).toContain("Couldn't reach MarketSharp: the connection failed.");
    expect(text).not.toContain('ECONNRESET');
  });

  it('tells a read that hit a 5xx or timeout to try again, with no duplicate warning', async () => {
    vendorReplies(() => json({}, 500));
    const serverError = await callText(READ);
    expect(serverError).toContain('Try again in a minute.');
    expect(serverError).not.toContain(DUPLICATE_WARNING);

    vendorReplies(() => {
      throw timeoutError();
    });
    const timedOut = await callText(READ);
    expect(timedOut).toContain("it didn't respond in time.");
    expect(timedOut).toContain('Try again in a minute.');
    expect(timedOut).not.toContain(DUPLICATE_WARNING);
  });

  it.each([400, 404])('does not warn about duplicates when a write gets a %i', async (status) => {
    vendorReplies(() => json({ meta: { message: 'Bad contact' } }, status));
    const text = await callText(NOTE, noteArgs);
    expect(text).toContain(`HTTP ${status}`);
    expect(text).not.toContain(DUPLICATE_WARNING);
    expect(text).not.toContain('Try again in a minute');
  });

  it('adds no retry advice on top of a sign-in 5xx, which already says when to retry', async () => {
    fetchMock.mockImplementation(async () => json({}, 503));
    const text = await callText(NOTE, noteArgs);
    expect(text).toContain("MarketSharp sign-in failed on MarketSharp's side (HTTP 503). Try again in a few minutes.");
    expect(text).not.toContain(DUPLICATE_WARNING);
    expect(text).not.toContain('Try again in a minute');
  });

  it.each([
    [401, 'Check the Company ID, API key, API secret and Employee ID on this connection.'],
    [403, "Ask a MarketSharp admin to give the connection's employee that permission, or use a different Employee ID."],
    [404, 'Check the ID, or look the record up with marketsharp_search_global.'],
  ])('HTTP %i gives a next step and reads as sentences, with and without vendor detail', async (status, step) => {
    const cases: Array<[unknown, string]> = [
      [{ meta: { message: 'Nope' } }, `: Nope. ${step}`],
      [{ meta: { message: 'Nope.' } }, `: Nope. ${step}`],
      [{}, `. ${step}`],
    ];
    for (const [body, expected] of cases) {
      clearTokenCache();
      vendorReplies(() => json(body, status));
      const text = await callText(READ);
      expect(text).toContain(`(HTTP ${status})${expected}`);
      expect(text).not.toContain('..');
    }
  });

  it('sends a rejected sign-in to the full API maintenance path, punctuated with and without detail', async () => {
    fetchMock.mockResolvedValueOnce(json({ error_description: 'The api key is invalid' }, 400));
    await expect(getToken(creds)).rejects.toThrow(
      '(HTTP 400): The api key is invalid. Check the key and secret under Admin → Apps & Add-ons Setup → API maintenance in MarketSharp.'
    );
    clearTokenCache();
    fetchMock.mockResolvedValueOnce(json({}, 401));
    await expect(getToken(creds)).rejects.toThrow('(HTTP 401). Check the key and secret under Admin');
  });

  it('says a token 5xx is MarketSharp-side and to try again', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 502));
    await expect(getToken(creds)).rejects.toThrow("sign-in failed on MarketSharp's side (HTTP 502). Try again in a few minutes.");
  });
});

describe('503 on POST reads', () => {
  it('is not retried, so a search is sent once', async () => {
    vendorReplies(() => new Response('busy', { status: 503, headers: { 'Retry-After': '0' } }));
    await expect(
      marketsharpRequest(creds, { method: 'POST', path: '/companies/123/contacts/search', body: { last_name: 'Smith' } })
    ).rejects.toThrow('HTTP 503');
    expect(fetchMock.mock.calls.filter(([u]) => !String(u).endsWith('/token'))).toHaveLength(1);
  });
});

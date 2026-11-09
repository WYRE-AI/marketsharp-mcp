# marketsharp-mcp

MCP server for the [MarketSharp](https://www.marketsharp.com/) CRM REST API
(`https://restapi.marketsharpm.com`, API version 2.0). It gives an AI assistant
read access to a home-improvement contractor's contacts, inquiries (leads),
appointments, jobs, notes and reference lists. Every tool is read-only.

Maintained by WYRE AI. It runs as a stdio server locally or as a stateless
Streamable HTTP server behind a gateway.

## Credentials

MarketSharp uses **application authentication**: the server exchanges your
Company ID, API key and API secret at `POST /token` for a short-lived bearer
token, caches it per credential set, and refreshes it on expiry or a 401.

| Variable | Gateway header | Required | Where to find it |
|---|---|---|---|
| `MARKETSHARP_COMPANY_ID` | `x-marketsharp-company-id` | yes | Shown under your username, top right in MarketSharp |
| `MARKETSHARP_API_KEY` | `x-marketsharp-api-key` | yes | Admin → Apps & Add-ons Setup → API maintenance → Create New API Key |
| `MARKETSHARP_API_SECRET` | `x-marketsharp-api-secret` | yes | Issued with the API key. If there's no secret, MarketSharp support has to turn on API access |
| `MARKETSHARP_EMPLOYEE_ID` | `x-marketsharp-employee-id` | no | MarketSharp employee ID. The contact, inquiry and job search tools, and `marketsharp_notes_list` need it, and act with that employee's permissions |

Use a dedicated MarketSharp employee set up for API access rather than a person's login.
The server never uses MarketSharp usernames or passwords.

## Tools (25, all read-only)

| Tool | MarketSharp endpoint |
|---|---|
| `marketsharp_companies_list` | `GET /companies` |
| `marketsharp_companies_get` | `GET /companies/{companyId}` |
| `marketsharp_search_global` | `POST …/search/global` (contacts, inquiries, jobs) |
| `marketsharp_contacts_get` | `GET …/contacts/{contactId}` |
| `marketsharp_contacts_search` | `POST …/contacts/search` (QuickFind, needs employee) |
| `marketsharp_contacts_list` | `POST …/contacts/filter` (paged, modified-since / appointment window) |
| `marketsharp_inquiries_get` | `GET …/inquiries/{inquiryId}` (optional `isAppointmentRequired`; MarketSharp defaults it to true) |
| `marketsharp_inquiries_list` | `POST …/inquiries/filter` (paged; optional `isAppointmentRequired`, which MarketSharp defaults to true) |
| `marketsharp_inquiries_search` | `POST …/inquiries/search` (QuickFind, needs employee) |
| `marketsharp_inquiries_list_by_contact` | `GET …/contacts/{contactId}/inquiries` (optional `isAppointmentRequired`) |
| `marketsharp_inquiry_statuses_list` | `GET …/inquiries/statuses` |
| `marketsharp_inquiry_notes_list` | `GET …/opportunities/{inquiryId}/notes/{Inquiry\|Job}` (needs View Opportunity Note) |
| `marketsharp_appointments_get` | `GET …/appointments/{appointmentId}` |
| `marketsharp_appointments_list` | `POST …/appointments/filter` (paged) |
| `marketsharp_appointments_list_by_contact` | `GET …/appointments/contacts/{contactId}` |
| `marketsharp_appointment_results_list` | `GET …/appointments/results/active` or `resultreasons/active` |
| `marketsharp_jobs_get` | `GET …/jobs/{jobId}` |
| `marketsharp_jobs_search` | `POST …/jobs/search` (QuickFind, needs employee) |
| `marketsharp_opportunities_list` | `POST …/jobs/opportunities` (jobs + leads since a date, contract totals; needs View Opportunity) |
| `marketsharp_notes_list` | `GET …/notes/contact/{contactId}` or by note type (needs employee) |
| `marketsharp_activity_types_list` | `GET …/activities/types` |
| `marketsharp_employees_list` | `GET …/employees` (paged) |
| `marketsharp_lead_sources_list` | `GET …/primaryleadsources[/…/secondaryleadsources]` |
| `marketsharp_product_interests_list` | `GET …/products/interests/{activeOnly}` or per inquiry (needs View Product Interest) |
| `marketsharp_divisions_list` | `GET …/divisions` |

There are no create, update or delete tools. Searches and filtered lists use
POST because that is how MarketSharp exposes them; they don't change data.
The client only sends the GET and POST routes these tools use (an allowlist of
route templates in `src/client.ts`). Any other request, including a GET no
tool uses, is refused before sign-in.

## Running

Requires Node.js 22 or later.

```bash
npm ci && npm run build
MARKETSHARP_COMPANY_ID=… MARKETSHARP_API_KEY=… MARKETSHARP_API_SECRET=… node dist/index.js   # stdio
```

The Docker image defaults to `MCP_TRANSPORT=http` and `AUTH_MODE=gateway`.
To run the image over stdio with `MARKETSHARP_*` credentials, pass
`-e MCP_TRANSPORT=stdio -e AUTH_MODE=env` as well; otherwise it fails closed
with "credentials are not configured".

HTTP (`MCP_TRANSPORT=http`, `/mcp` + `/health`) refuses to start without a real
`CONDUIT_S2S_SECRET` (at least 32 characters, not a known or placeholder-looking
value, not a repeated pattern, at least 8 distinct characters) and requires a
valid `X-Gateway-S2S` header on every `/mcp` request. `/mcp` takes POST only
(405 with `Allow: POST` otherwise). `MCP_ALLOWED_HOSTS` (comma-separated, off
when unset) limits the Host headers `/mcp` accepts. Every response sets
`Cache-Control: no-store`.

- `AUTH_MODE` is `gateway` (the default when unset) or `env`. Any other value
  refuses to start. In `gateway` mode credentials come only from the
  `x-marketsharp-*` headers; `MARKETSHARP_*` env is never read. `env` is for a
  single tenant and reads `MARKETSHARP_*` from the environment; over HTTP it
  refuses to start unless the company id, API key and API secret are set and
  the ids look like MarketSharp ids. Stdio uses the
  environment only when `AUTH_MODE` is unset or exactly `env`; any other value
  (including a typo) is treated as `gateway`, so env credentials are never used
  by mistake.
- Tool tiers: `read` is the only tier. Conduit's `X-Conduit-Tool-Tiers`
  header can only narrow that set for one request. A present but empty header
  means no tools at all. Unlike the fleet template there is deliberately no
  `MARKETSHARP_TOOL_TIERS` variable: with one tier there is nothing to choose,
  and nothing in the environment can change the tier set.
- Every request goes to the fixed host `https://restapi.marketsharpm.com` at
  exactly the path that was built. Ids in paths must look like MarketSharp ids
  (1-64 letters, digits or dashes, which covers numbers and GUIDs); anything
  else is rejected before any request. Redirects are refused (`redirect: 'manual'`, any 3xx is
  an error), so the bearer token never leaves the host. Response bodies are
  read with a 4 MiB cap.
- Tool output, tool errors and log lines are redacted: the API key and secret
  in use (env or per request), bearer tokens and JWTs become `[REDACTED]`.
  In MarketSharp responses, values under credential-named keys (`apiKey`,
  `authorization`, `token`, `accessToken`, `refreshToken`, and any key ending
  in `password` or `secret`) are redacted too.
  Arguments a tool doesn't declare are dropped before it runs. Vendor errors
  keep the HTTP status, MarketSharp's message and, when sent, the request id
  (`x-request-id`, `request-id` or `x-correlation-id`).
- Page sizes and record counts above a tool's maximum are rejected, not
  silently lowered, so "fewer rows than `rowsPerPage` means the last page"
  stays true. Pages are passed through as given; the server never fetches
  more than one page per call.
- `MCP_ALLOW_INSECURE_DEV=1` lets HTTP start without a secret, on 127.0.0.1
  only, and requires `NODE_ENV=development`. With any other `NODE_ENV` the
  server refuses to start.
- Tool output is MarketSharp data that other people may have typed (lead
  forms, notes, names). Every successful result is escaped and wrapped in
  `<untrusted-content nonce="…">` markers behind a notice telling the model
  not to follow instructions inside it. MarketSharp's own error text is
  wrapped the same way.

See `.env.example`. The image's health check probes `/health` only when
`MCP_TRANSPORT=http`.

## Limits and unknowns

- MarketSharp doesn't publish rate limits. The server retries 429 with
  `Retry-After` or exponential backoff (3 tries). A 503 is retried only for
  GET requests. Searches and filtered lists (which use POST) return it instead.
- The `/token` 200 response shape isn't documented. The server accepts
  `access_token` or `token`, top level or inside `response`, or a bare JWT
  body (plain or JSON-quoted).
- HTTP request bodies are capped at 256 KiB (262,144 bytes). Larger bodies,
  declared or chunked, get a 413.
- Responses are capped at 200,000 characters; narrow with filters or paging.
  An oversized list keeps whole records and its paging fields (also when the
  page sits under `response` or `data`), and a note says how many records
  were left out. On the paged lists the note names the exact `pageNumber` and
  `rowsPerPage` (`page` and `pageSize` for employees) that read on from the
  first record left out; other tools can't page, so it says to narrow with
  filters. A list whose first record alone is over the cap is cut as text.
- The QuickFind searches always send `numberOfRecords` (default 25): it is a
  non-nullable int32 in the spec, and what MarketSharp does with 0 is
  undocumented.
- Not covered: calendar, texting, email, PaySimple, QuickBooks, CompanyCam,
  automation rules, analytics, estimates (v1 only), and all admin/config writes.

## Development

```bash
npm ci --ignore-scripts
npm run typecheck        # tsc --noEmit
npm run lint             # eslint + destructive-tool warning lint
npm run lint:destructive # destructive-tool warning lint only
npm run build
npm test                 # vitest, no network
npm run smoke            # spawns dist/index.js over stdio, no network
```

`evals/` holds the mcp-assert suite that CI runs against the built server.

Each release publishes `ghcr.io/wyre-ai/marketsharp-mcp`, and its release notes are on the GitHub Release for that version.

## License

Apache-2.0

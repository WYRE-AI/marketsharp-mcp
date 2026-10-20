# marketsharp-mcp

MCP server for the [MarketSharp](https://www.marketsharp.com/) CRM REST API
(`https://restapi.marketsharpm.com`, API version 2.0). It gives an AI assistant
read access to a home-improvement contractor's contacts, inquiries (leads),
appointments, jobs, notes and reference lists, plus four create-only write tools
that are off by default.

Built by WYRE for [Conduit](https://conduit.wyre.ai) (Linear WYREAI-526). It runs
as a stdio server locally or as a stateless Streamable HTTP sidecar behind the
Conduit gateway.

## Credentials

MarketSharp uses **application authentication**: the server exchanges your
Company ID, API key and API secret at `POST /token` for a short-lived bearer
token, caches it per credential set, and refreshes it on expiry or a 401.

| Variable | Gateway header | Required | Where to find it |
|---|---|---|---|
| `MARKETSHARP_COMPANY_ID` | `x-marketsharp-company-id` | yes | Shown under your username, top right in MarketSharp |
| `MARKETSHARP_API_KEY` | `x-marketsharp-api-key` | yes | Admin → Apps & Add-ons Setup → API maintenance → Create New API Key |
| `MARKETSHARP_API_SECRET` | `x-marketsharp-api-secret` | yes | Issued with the API key. If there's no secret, MarketSharp support has to turn on API access |
| `MARKETSHARP_EMPLOYEE_ID` | `x-marketsharp-employee-id` | no | MarketSharp employee ID. Search and note tools need it and act with that employee's permissions |

Use a dedicated MarketSharp admin/API employee rather than a person's login.
The server never uses MarketSharp usernames or passwords.

## Tools (29)

Reads (25, always on):

| Tool | MarketSharp endpoint |
|---|---|
| `marketsharp_companies_list` | `GET /companies` |
| `marketsharp_companies_get` | `GET /companies/{companyId}` |
| `marketsharp_search_global` | `POST …/search/global` (contacts, inquiries, jobs) |
| `marketsharp_contacts_get` | `GET …/contacts/{contactId}` |
| `marketsharp_contacts_search` | `POST …/contacts/search` (QuickFind, needs employee) |
| `marketsharp_contacts_list` | `POST …/contacts/filter` (paged, modified-since / appointment window) |
| `marketsharp_inquiries_get` | `GET …/inquiries/{inquiryId}` |
| `marketsharp_inquiries_list` | `POST …/inquiries/filter` (paged) |
| `marketsharp_inquiries_search` | `POST …/inquiries/search` (QuickFind, needs employee) |
| `marketsharp_inquiries_list_by_contact` | `GET …/contacts/{contactId}/inquiries` |
| `marketsharp_inquiry_statuses_list` | `GET …/inquiries/statuses` |
| `marketsharp_inquiry_notes_list` | `GET …/opportunities/{inquiryId}/notes/{Inquiry\|Job}` |
| `marketsharp_appointments_get` | `GET …/appointments/{appointmentId}` |
| `marketsharp_appointments_list` | `POST …/appointments/filter` (paged) |
| `marketsharp_appointments_list_by_contact` | `GET …/appointments/contacts/{contactId}` |
| `marketsharp_appointment_results_list` | `GET …/appointments/results/active` or `resultreasons/active` |
| `marketsharp_jobs_get` | `GET …/jobs/{jobId}` |
| `marketsharp_jobs_search` | `POST …/jobs/search` (QuickFind, needs employee) |
| `marketsharp_opportunities_list` | `POST …/jobs/opportunities` (jobs + leads since a date, contract totals) |
| `marketsharp_notes_list` | `GET …/notes/contact/{contactId}` or by note type (needs employee) |
| `marketsharp_activity_types_list` | `GET …/activities/types` |
| `marketsharp_employees_list` | `GET …/employees` (paged) |
| `marketsharp_lead_sources_list` | `GET …/primaryleadsources[/…/secondaryleadsources]` |
| `marketsharp_product_interests_list` | `GET …/products/interests/{activeOnly}` or per inquiry |
| `marketsharp_divisions_list` | `GET …/divisions` |

Writes (4, hidden unless `MARKETSHARP_ENABLE_WRITES=true`). MarketSharp's save
endpoints are upserts. These tools never send a record id, so they only create:

| Tool | Endpoint | Notes |
|---|---|---|
| `marketsharp_contact_notes_create` | `POST …/notes/contactNote` | Needs an employee |
| `marketsharp_inquiry_notes_create` | `POST …/opportunities/notes` | |
| `marketsharp_activities_create` | `POST …/activities` | MarketSharp automation rules don't run |
| `marketsharp_appointments_create` | `POST …/appointments` | Reads the inquiry first (`isAppointmentRequired=false`, so a lead with no appointment yet is found) and sends its address, coordinates and notes back unchanged, because MarketSharp's save rewrites them. Refuses to book if the inquiry response is missing any of those fields |

There are no delete tools. The REST API has no endpoint to create a contact or an
inquiry (lead), so this server can't either.

## Running

Requires Node.js 22 or later.

```bash
npm ci && npm run build
MARKETSHARP_COMPANY_ID=… MARKETSHARP_API_KEY=… MARKETSHARP_API_SECRET=… node dist/index.js   # stdio
```

HTTP (`MCP_TRANSPORT=http`, `/mcp` + `/health`) refuses to start without a real
`CONDUIT_S2S_SECRET` and requires a valid `X-Gateway-S2S` header on every `/mcp`
request. With `AUTH_MODE=gateway` (the image default) credentials come only from
the `x-marketsharp-*` headers; env credentials are never used as a fallback.
See `.env.example`. The create tools stay off unless `MARKETSHARP_ENABLE_WRITES=true`;
`docker-compose.yml` passes it through and defaults it to `false`. The image's
health check probes `/health` only when `MCP_TRANSPORT=http`.

## Limits and unknowns

- MarketSharp doesn't publish rate limits. The server retries 429 with
  `Retry-After` or exponential backoff (3 tries). A 503 is retried only for
  reads: the create tools return it instead of retrying, since the record may
  already have been saved and retrying could create a duplicate.
- The `/token` 200 response shape isn't documented. The server accepts
  `access_token` or `token`, top level or inside `response`, or a bare JWT
  body (plain or JSON-quoted).
- Responses are capped at 200,000 characters; narrow with filters or paging.
- Not covered: calendar, texting, email, PaySimple, QuickBooks, CompanyCam,
  automation rules, analytics, estimates (v1 only), and all admin/config writes.

## Development

```bash
npm test        # vitest
npm run lint    # tsc --noEmit
```

Releases are cut by semantic-release on `main` through
`WYRE-AI/reusable-workflows` (`mcp-server-release.yml`), publishing
`ghcr.io/wyre-ai/marketsharp-mcp`. The image build stamps the release version
(the `VERSION` build arg) into `package.json`, so the server reports it. Release notes are published on the
GitHub Release for each version; like the rest of the fleet, `main` is
branch-protected, so the release job doesn't commit `CHANGELOG.md` back.

## License

Apache-2.0

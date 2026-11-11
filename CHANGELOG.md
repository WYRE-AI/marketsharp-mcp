# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Released versions are appended by semantic-release from Conventional Commits, and
their notes are also on [GitHub Releases](https://github.com/WYRE-AI/marketsharp-mcp/releases).

## [Unreleased]

### Added

- MCP server for the MarketSharp CRM REST API v2.0 (WYREAI-526): 25 read-only
  tools. Stdio and stateless streamable HTTP (Conduit gateway) transports.
- `X-Conduit-Tool-Tiers` support. `read` is the only tier and the header can
  only narrow it. A present but empty header exposes no tools. There is
  deliberately no `MARKETSHARP_TOOL_TIERS` variable (the fleet template's
  `<VENDOR>_TOOL_TIERS`): with one tier there is nothing to configure.
- Redaction of the API key and secret in use, bearer tokens and JWTs in tool
  output, tool errors and every log line. MarketSharp responses and error text
  are also redacted of the current access token and of values under
  credential-named JSON keys (`apiKey`, `authorization`, `token`,
  `accessToken`, `refreshToken`, and any key ending in `password` or `secret`,
  such as `smtpPassword` or `webhook_secret`). Redaction runs before any
  escaping or truncation, so
  a secret containing `&`, `<` or `>`, or one cut at a size cap, can't survive
  in part.
- Vendor request id (`x-request-id`, `request-id` or `x-correlation-id`) in
  error messages when MarketSharp sends one.
- Optional `appointmentRequired` (MarketSharp `isAppointmentRequired`) on
  `marketsharp_inquiries_get`, `marketsharp_inquiries_list` and
  `marketsharp_inquiries_list_by_contact`. Each description warns that
  MarketSharp defaults it to true, which hides inquiries with no appointment.
- The paged filter lists (contacts, inquiries, appointments) say that fewer
  rows than `rowsPerPage` means the last page.
- `typecheck`, `lint` (eslint plus the destructive-tool warning lint),
  `lint:destructive` and `smoke` (stdio, no network) scripts, an mcp-assert
  `evals/` suite, and gitleaks, CI and mcp-assert workflows.
- A test that checks every request a tool builds, GET and POST, against a
  vendored, trimmed copy of the MarketSharp v2 spec: the method and path must
  match a spec route and query parameters must be ones it declares. POST
  bodies are also checked against the request models (keys, required fields,
  types, enums).

### Changed

- Redirects are refused with `redirect: 'manual'` and an explicit error for any
  3xx, on `/token` and on every API call.
- Every request URL is checked to be on `https://restapi.marketsharpm.com` at
  exactly the built path. Path ids must be MarketSharp ids: 1-64 letters,
  digits or dashes (numbers and GUIDs), the same shape the HTTP server
  requires of the company and employee ids. Look-alike dots (`．．`), `∕`,
  `?` and `#` are rejected along with separators and `..`.
- Response bodies are read with a 4 MiB streaming cap.
- Page sizes and record counts above a tool's maximum (`rowsPerPage` 1000,
  `opportunities_list` `numberOfRecords` 1000, `pageSize` 500, search
  `numberOfRecords` 500 or 200) are rejected before any request instead of
  being silently lowered. A lowered `rowsPerPage` made a full page look
  shorter than asked for, so the model read it as the last page and stopped.
  `inquiryIds` is limited to the documented 100.
- Arguments a tool doesn't declare are dropped before the tool runs.
- An error inside the HTTP `/mcp` handler returns a JSON-RPC 500 and logs
  only the error type, instead of becoming an unhandled rejection that would
  stop the process for every tenant.
- Any `AUTH_MODE` other than unset or `env` now means gateway mode outside HTTP
  too, so `MARKETSHARP_*` env credentials are never read by mistake.
- HTTP startup also refuses a `CONDUIT_S2S_SECRET` that looks like a
  placeholder, is a repeated pattern, or has fewer than 8 distinct characters.
- The Docker base image is pinned by digest and the builder copies only
  `src/` and the build config.
- Release runs on push to `main` again, through the reusable pipeline at
  `508ef4dd` with `fail-on-severity: HIGH,CRITICAL`.

### Security

- `/mcp` accepts only POST. Any other method gets 405 with `Allow: POST`
  after the S2S check, so a signed GET can no longer open the SDK's standalone
  SSE stream and hold a tenant's credential context open.
- Optional `MCP_ALLOWED_HOSTS` Host-header allowlist on `/mcp` (403 when the
  Host isn't listed). Every response sets `Cache-Control: no-store`.
- HTTP with `AUTH_MODE=env` refuses to start when `MARKETSHARP_COMPANY_ID`,
  `MARKETSHARP_API_KEY` or `MARKETSHARP_API_SECRET` is empty, or when the
  company or employee id is not a MarketSharp id, instead of reporting healthy
  and failing every tool call.
- MarketSharp calls stop when the gateway client disconnects: the fetch and
  any 429 backoff are aborted instead of running on with the tenant's token
  for up to about a minute. The shared `/token` mint keeps only its timeout.
- The client refuses any MarketSharp request that isn't one of the GET or POST
  routes the tools use (an allowlist of route templates), before minting a
  token, so no tool or later change can write to MarketSharp. GETs are
  allowlisted too because not every MarketSharp GET is a pure read (one
  "opens the existing work order for editing").
- Log lines redact the access tokens used in the current HTTP request by exact
  match, so an opaque (non-JWT) token is caught too.
- A full token cache (500 credential sets) drops expired tokens and then the
  oldest one, instead of clearing every tenant's token at once.
- Request paths are matched with the same id shape the tools accept (1-64
  letters, digits or dashes) instead of any non-`/` text, so the read-only
  allowlist no longer passes a path with a newline, `?`, `#`, `..` or `%2F`.
- A tool call that fails with anything other than a MarketSharp error returns
  only "Unexpected internal error". The error's name and code are logged, never
  its message.
- A sign-in that MarketSharp refuses with 400, 401 or 403 is remembered for 45
  seconds per credential set and re-thrown without a `/token` call. Network
  errors, 429 and 5xx are not remembered.
- The `MCP_ALLOWED_HOSTS` check compares the parsed hostname, so an IPv6 Host
  with a port (`[::1]:8080`) matches `[::1]`. A malformed Host is a 403. Ports
  in `MCP_ALLOWED_HOSTS` entries are ignored.
- One request has at most 4 MarketSharp calls in flight, so a JSON-RPC batch
  of tool calls can't fan out into one upstream call per message. A call holds
  its slot from the start of the fetch until its response body is fully read
  (or fails or is cancelled), so at most 4 connections and bodies are open per
  request. A 429/503 retry wait and the token refresh don't hold a slot.
  Calls waiting for a slot, and bodies being read, stop when the gateway
  client disconnects.

### Fixed

- A failure while reading a MarketSharp response body (a connection reset
  mid-stream, or the 30 s request timeout) is reported like a failed fetch
  ("Couldn't reach MarketSharp: ...") instead of as an unexpected internal
  error.
- An oversized list response is cut at a record boundary instead of mid-text:
  paging fields (`pageNumber`, `totalPageCount`, `meta`) are kept, also when
  the page sits one level down under `response` or `data`, and a note gives
  how many records were left out, so a cut page is never read as the last
  one. On the paged lists the note names the exact page number and page size
  that read on from the first record left out, on any page (asking page N+1
  at a smaller size used to skip or repeat records after page 1). Tools
  without paging are told to narrow with filters instead of being sent after
  a page-size argument they don't have. A list whose first record alone is
  over the cap falls back to the text cut, so part of it is still shown.
- The QuickFind searches (`marketsharp_contacts_search`,
  `marketsharp_inquiries_search`, `marketsharp_jobs_search`) always send
  `numberOfRecords`, 25 unless given. It is a non-nullable int32 in the spec,
  so leaving it out sent 0, whose meaning is undocumented.
- Tool descriptions no longer state MarketSharp defaults the spec doesn't
  document (`numberOfRecords` on the searches, `rowsPerPage` on the contact
  and appointment filters). The inquiries filter does document one
  (`pageNumber` 1, `rowsPerPage` 1000); the tool always sends its own 100.
  `marketsharp_opportunities_list` says it can't page past `numberOfRecords`
  and that a full result may be incomplete (it no longer suggests moving
  `fromDate`, which skips records when the sort order is unknown).
- Tool descriptions name the permissions the spec requires: View Opportunity
  Note on `marketsharp_inquiry_notes_list` (which no longer claims an
  Employee ID is required), View Opportunity on
  `marketsharp_opportunities_list` and View Product Interest on
  `marketsharp_product_interests_list`.
- An ASP.NET model-binding 400 now names the first `ModelState` field error
  (redacted and truncated like other vendor text) instead of only "The
  request is invalid.".
- JWT redaction is a single linear pass instead of a regex that was quadratic
  on input such as `-eyJ` repeated (100 KB took about 3 s; 4 MB now takes
  milliseconds). It no longer needs a word boundary, so a JWT glued to other
  text or to another JWT is fully redacted. A test checks that nothing the
  old regex matched survives, and that redaction time grows linearly.
- The `server.json` OCI package now defaults `MCP_TRANSPORT` to `stdio` and
  `AUTH_MODE` to `env`, matching its declared stdio transport, so a registry
  install no longer starts the HTTP gateway listener without credentials.

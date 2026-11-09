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
  only narrow it. A present but empty header exposes no tools.
- Redaction of the API key and secret in use, bearer tokens and JWTs in tool
  output, tool errors and every log line. MarketSharp responses and error text
  are also redacted of the current access token and of values under
  credential-named JSON keys (`apiKey`, `secret`, `password`,
  `authorization`, ...). Redaction runs before any escaping or truncation, so
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
- A test that checks every POST body a tool builds against a vendored, trimmed
  copy of the MarketSharp v2 request models (keys, required fields, types,
  enums, query parameters).

### Changed

- Redirects are refused with `redirect: 'manual'` and an explicit error for any
  3xx, on `/token` and on every API call.
- Every request URL is checked to be on `https://restapi.marketsharpm.com` at
  exactly the built path. Path ids reject `/`, `\`, encoded separators or dots
  and control characters, as well as `.` and `..`.
- Response bodies are read with a 4 MiB streaming cap.
- Page sizes and record counts above the cap are capped instead of rejected.
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

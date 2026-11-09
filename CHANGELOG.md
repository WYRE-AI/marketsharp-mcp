# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Released versions are appended by semantic-release from Conventional Commits, and
their notes are also on [GitHub Releases](https://github.com/WYRE-AI/marketsharp-mcp/releases).

## [Unreleased]

### Added

- MCP server for the MarketSharp CRM REST API v2.0 (WYREAI-526): 25 read tools
  and 4 create-only write tools that stay hidden unless
  `MARKETSHARP_ENABLE_WRITES=true`. Stdio and stateless streamable HTTP
  (Conduit gateway) transports.
- `X-Conduit-Tool-Tiers` support. The header can only narrow the container's
  tiers (`read`, plus `write` when writes are on). A present but empty header
  exposes no tools.
- Redaction of the API key and secret in use, bearer tokens and JWTs in tool
  output, tool errors and every log line.
- Vendor request id (`x-request-id`, `request-id` or `x-correlation-id`) in
  error messages when MarketSharp sends one.
- Optional `appointmentRequired` (MarketSharp `isAppointmentRequired`) on
  `marketsharp_inquiries_get` and `marketsharp_inquiries_list_by_contact`.
  MarketSharp defaults it to true, which hides inquiries with no appointment.
- `typecheck`, `lint` (eslint plus the destructive-tool warning lint),
  `lint:destructive` and `smoke` (stdio, no network) scripts, an mcp-assert
  `evals/` suite, and gitleaks, CI and mcp-assert workflows.

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
- Any `AUTH_MODE` other than unset or `env` now means gateway mode outside HTTP
  too, so `MARKETSHARP_*` env credentials are never read by mistake.
- HTTP startup also refuses a `CONDUIT_S2S_SECRET` that looks like a
  placeholder, is a repeated pattern, or has fewer than 8 distinct characters.
- The Docker base image is pinned by digest and the builder copies only
  `src/` and the build config.
- Release runs on push to `main` again, through the reusable pipeline at
  `508ef4dd` with `fail-on-severity: HIGH,CRITICAL`.

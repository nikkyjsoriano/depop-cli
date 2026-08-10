# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

mastro · connect turns an already-authenticated browser session into a CLI/API. A Chrome
extension captures a session's credential (cookies/headers), the credential is replayed
against the target app's (reverse-engineered) API, and each API operation is exposed as a
`mastro <provider> <command>` CLI verb — JSON in, JSON out, agent-ready.

The central design commitment: **adding a connector is data, not code.** A connector is an
OpenAPI 3.1 document plus a browser-capture manifest, dropped under `providers/`. The same
rails (packages/core + packages/sdk) handle login, request building, filters, pagination,
and multi-step flows for every connector — there is no per-connector TypeScript.

## Commands

```bash
bun install          # install deps (Bun workspaces)
bun test             # run the full test suite (bun:test, all packages)
bun test <path>      # run a single test file, e.g. bun test packages/sdk/test/workflow.test.ts
bun run typecheck    # tsc --noEmit for packages/* AND extension/ (two separate tsconfig roots)
bun run build        # bundles packages/cli/src/bin.ts -> dist/ (only needed for the npm package)
bun run mastro …     # run the CLI from source, e.g. bun run mastro depop search "..." --json
```

Run `bun test` and `bun run typecheck` before opening a PR — both are cheap and catch the
most common regressions (see the extension type-mirror gotcha below).

No separate lint script; typechecking (strict TS) is the primary static check. Provider
OpenAPI specs should validate cleanly with a standard OpenAPI 3.1 linter (e.g. `redocly
lint`) — this isn't currently wired into `bun test`.

## Architecture

Four moving parts, connected by files under `providers/<id>/`:

1. **`extension/`** — a generic Manifest V3 Chrome extension, plain JS (`checkJs`-verified
   via `extension/tsconfig.json`, no bundler). It has **zero per-connector code**: during
   `mastro login <id>` it interprets whatever `auth.manifest.json` the CLI hands it —
   watching cookies (`chrome.cookies`), headers (`webRequest`), and page fetch/XHR via an
   injected page-bridge (`page-bridge.js`) — decides capture is complete from the manifest's
   declarative rules, and posts a minimal credential bundle back to a loopback receiver. It
   also serves as the **browser proxy**: for providers that set
   `x-mastro-replay.via_browser`, live requests are executed inside the user's
   already-logged-in tab (past Cloudflare-style challenges) instead of over a raw HTTP
   client.

2. **`packages/core`** (`@mastro/core`) — the engine: the **broker** (`broker.ts`) drives a
   capture session (stands up the localhost **receiver** in `receiver.ts`, opens the
   browser, waits for the bundle, validates it); the **credential store** (`store.ts`) is a
   pluggable interface, currently a file store under `~/.mastro/` at mode `0600`; the
   **OpenAPI loader** (`openapi.ts`, `openapi-spec.ts`) loads and validates each provider's
   spec; `schemas/` holds the JSON Schemas (Ajv) for manifests and specs, including
   `browser-auth-manifest.schema.json`, the canonical shape of `auth.manifest.json`.
   `redact.ts` strips secrets before anything is logged.

3. **`packages/sdk`** (`@mastro/sdk`) — the replay layer: `connector.ts` builds a request
   from an OpenAPI operation + CLI flags (query/path/body params, array `style`/`explode`,
   enum validation, defaults); `template.ts` applies `x-mastro-auth` bindings (header/cookie
   templates, per-request `${uuid}`/`${now}` values); `resolver.ts` resolves
   `x-mastro-resolve` dynamic enums against the app's own taxonomy endpoints (cached under
   `~/.mastro/cache/<id>/`, default 24h TTL — via `cache.ts`); `transport.ts` /
   `browser-transport.ts` pick the right transport (direct HTTP vs. browser proxy);
   `extract.ts` turns HTML-only responses into structured data via `x-mastro-extract` CSS
   selectors (needed where there's no JSON API at all, e.g. Amazon); `form.ts` handles
   `x-mastro-form` CSRF-guarded form submissions; `workflow.ts` runs multi-step
   `x-mastro-workflow` flows (`foreach`, `poll`-until, per-step transport); `flight.ts`
   supports SDUI/Flight-style structured surfaces (see the LinkedIn connector).

4. **`packages/cli`** (`@mastro/cli`) — the `mastro` binary (`bin.ts` → `cli.ts`). Built-in
   verbs are `login`, `logout`, `status`, `providers`, `skills`, `extension`; every other
   `mastro <provider> <command>` is **generated from the provider's OpenAPI operations** —
   flags come from operation parameters, allowed values from `schema.enum`, help text is
   auto-generated. The CLI is meant to stay a thin, faithful projection of the spec; new
   connector behavior belongs in the provider's `openapi.yaml`, not in CLI code.

### The `x-mastro-*` OpenAPI extensions

Standard OpenAPI covers paths/methods/params/enums/auth inventory. Everything
reverse-engineering-specific lives in vendor extensions (ignored by conformant OpenAPI
validators, so specs stay valid OpenAPI 3.1):

| Extension | Where | Solves |
| --- | --- | --- |
| `x-mastro-auth` | root | Turning a captured credential into a live request: header/cookie templates + generated values (`${uuid}`, `${now}`) |
| `x-mastro-resolve` | parameter | Dynamic enums sourced from another operation's response or bundled reference data |
| `x-mastro-replay` | root | Transport tuning: browser impersonation/proxy, retry/recapture status codes, rate limits, HTML meta-refresh bot walls |
| `x-mastro-extract` | operation | CSS-selector scraping for HTML-only responses (no JSON API) |
| `x-mastro-form` | workflow step's `request` | CSRF-token form submissions, serialized like a real browser `<form>` POST |
| `x-mastro-workflow` | operation | Multi-step stateful flows (upload → poll → create) |
| `x-mastro-command` / `x-mastro-result` / `x-mastro-hidden` | operation | CLI projection: subcommand name, response path to print, hide metadata-only endpoints |

Full reference: `docs/AUTHORING.md`. Also see `docs/BROWSER-PROXY.md` and `docs/WORKFLOWS.md`.

### Providers

`providers/<id>/` = `auth.manifest.json` (capture rules) + `openapi.yaml` (API surface) +
`README.md` (how it works, how it was reverse-engineered, drift symptoms) + optional
`reference/` (bundled taxonomy JSON) + `skills/<skill>/SKILL.md` (agent playbooks). No code.
Current connectors: `depop`, `amazon`, `linkedin`. `providers/depop` is the reference
example the docs point to.

Out-of-tree providers can be pointed at via `MASTRO_PROVIDERS=/path/to/dir`. Users can also
pull a connector's latest definition straight from GitHub with `mastro providers add <id>`
(pinned to a commit, shadows the bundled copy) — useful when a site changes faster than
releases.

### Agent skills

Every connector ships `SKILL.md` playbooks (frontmatter: `name`, `description`, single-line
YAML) under `providers/<id>/skills/<skill>/`, installed via `mastro skills add <id>[/<skill>]`
into `.claude/skills` (or `--global`, or `--dir <path>`). Installed skills carry a
`.mastro.json` provenance stamp so `mastro skills update` knows what it owns. `skills/mastro/`
is the root skill (session model: login, `status --json`, exit codes) every provider skill
builds on and every install includes.

## Gotchas

- **`extension/types.d.ts` is a hand-maintained mirror**, not generated. It re-declares the
  auth-manifest shape as ambient types so the plain-JS extension can be `checkJs`-verified
  without importing `@mastro/core`. `packages/core/test/extension-types-drift.test.ts`
  asserts every field name in `browser-auth-manifest.schema.json` also appears in
  `extension/types.d.ts` (name-level check, not structural). If you add/rename a field in the
  schema, update the mirror or the test fails — and if the extension intentionally doesn't
  read a field, add it to that test's `EXTENSION_IGNORES` set.
- **Two separate typecheck roots**: `tsconfig.json` (Bun/TS packages, `paths` mapping
  `@mastro/core`/`@mastro/sdk` to source) and `extension/tsconfig.json` (plain JS,
  `checkJs`, DOM + `chrome` types, no bundler). `bun run typecheck` runs both — a change that
  only touches one side can still break the other via the manifest schema.
- Never commit credentials, unredacted HARs, or capture bundles — `.gitignore` covers the
  obvious cases but double-check provider PRs by hand. `redact.ts` (core) is the runtime
  guard for logs; it does not protect files you add manually.
- The credential store writes to `~/.mastro/` at mode `0600`; taxonomy resolution caches to
  `~/.mastro/cache/<id>/`. Tests that touch these paths should not assume a clean/writable
  `~/.mastro` in CI — check how existing tests (e.g. `packages/core/test/capture-flow.test.ts`)
  isolate this.
- Bun workspaces (`packages/*`) — packages resolve `@mastro/core`/`@mastro/sdk` via
  `workspace:*`, and `tsconfig.json` additionally maps those specifiers straight to
  `src/index.ts` for typechecking without a build step. There is no per-package build; only
  `bun run build` (bundling `packages/cli/src/bin.ts`) exists, and it's only needed for the
  npm package (`prepack` runs it automatically).
- `bin/mastro.cjs` is the Node launcher shim used by `npm install -g` / `npx` consumers; from
  a repo checkout, prefer `bun run mastro …` (runs `packages/cli/src/bin.ts` directly via Bun,
  no build step).

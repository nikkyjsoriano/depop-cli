# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What this is

**depop cli** turns an already-authenticated Depop browser session into a CLI/API. A Chrome
extension captures the session's credential (cookies/headers), the credential is replayed
against Depop's (reverse-engineered) API, and each API operation is exposed as a `depop
<command>` CLI verb — JSON in, JSON out, agent-ready.

The central design commitment: **the connector is data, not code.** The whole surface is an
OpenAPI 3.1 document plus a browser-capture manifest under `spec/`. The rails
(packages/core + packages/sdk) handle login, request building, filters, pagination, and
multi-step flows — there is no per-endpoint TypeScript. When Depop's API drifts, the fix is
a spec edit.

## Commands

```bash
bun install          # install deps (Bun workspaces)
bun test             # run the full test suite (bun:test, all packages)
bun test <path>      # run a single test file, e.g. bun test packages/sdk/test/workflow.test.ts
bun run typecheck    # tsc --noEmit for packages/* AND extension/ (two separate tsconfig roots)
bun run build        # bundles packages/cli/src/bin.ts -> dist/ (only needed for the npm package)
bun run depop …      # run the CLI from source, e.g. bun run depop search "..." --json
```

Run `bun test` and `bun run typecheck` before opening a PR — both are cheap and catch the
most common regressions (see the extension type-mirror gotcha below).

No separate lint script; typechecking (strict TS) is the primary static check.
`spec/openapi.yaml` should validate cleanly with a standard OpenAPI 3.1 linter (e.g.
`redocly lint`) — this isn't currently wired into `bun test`.

## Architecture

Four moving parts, connected by the files under `spec/`:

1. **`extension/`** — a generic Manifest V3 Chrome extension, plain JS (`checkJs`-verified
   via `extension/tsconfig.json`, no bundler). It has **zero site-specific code**: during
   `depop login` it interprets whatever `auth.manifest.json` the CLI hands it — watching
   cookies (`chrome.cookies`), headers (`webRequest`), and page fetch/XHR via an injected
   page-bridge (`page-bridge.js`) — decides capture is complete from the manifest's
   declarative rules, and posts a minimal credential bundle back to a loopback receiver. It
   also serves as the **browser proxy**: because the spec sets `x-depop-replay.via_browser`,
   live requests are executed inside the user's already-logged-in tab (past Cloudflare's
   managed challenge) instead of over a raw HTTP client.

2. **`packages/core`** (`@depop/core`) — the engine: the **broker** (`broker.ts`) drives a
   capture session (stands up the localhost **receiver** in `receiver.ts`, opens the
   browser, waits for the bundle, validates it); the **credential store** (`store.ts`) is a
   pluggable interface, currently a single file at `~/.depop/credential.json`, mode `0600`;
   the **definition loader** (`definition.ts`, `openapi.ts`, `openapi-spec.ts`) loads and
   validates `spec/`; `schemas/` holds the JSON Schemas (Ajv) for the manifest, including
   `browser-auth-manifest.schema.json`. `redact.ts` strips secrets before anything is logged.

3. **`packages/sdk`** (`@depop/sdk`) — the replay layer: `connector.ts` builds a request
   from an OpenAPI operation + CLI flags (query/path/body params, array `style`/`explode`,
   enum validation, defaults); `template.ts` applies `x-depop-auth` bindings (header/cookie
   templates, per-request `${uuid}`/`${now}` values); `resolver.ts` resolves
   `x-depop-resolve` dynamic enums against Depop's own taxonomy endpoints or bundled
   reference JSON (cached under `~/.depop/cache/`, default 24h TTL — via `cache.ts`);
   `transport.ts` / `browser-transport.ts` pick the right transport (direct HTTP vs. browser
   proxy); `workflow.ts` runs multi-step `x-depop-workflow` flows (`foreach`, `poll`-until,
   per-step transport); `throttle.ts` paces requests to the spec's rate limit.

4. **`packages/cli`** (`@depop/cli`) — the `depop` binary (`bin.ts` → `cli.ts`). Built-in
   verbs are `login`, `logout`, `status`, `skills`, `extension`; **every other token is
   looked up as a command in the spec** and dispatched by `commands/call.ts` — flags come
   from operation parameters, allowed values from `schema.enum`, help text is
   auto-generated. The CLI is meant to stay a thin, faithful projection of the spec; new
   behavior belongs in `spec/openapi.yaml`, not in CLI code.

### The `x-depop-*` OpenAPI extensions

Standard OpenAPI covers paths/methods/params/enums/auth inventory. Everything
reverse-engineering-specific lives in vendor extensions (ignored by conformant OpenAPI
validators, so the spec stays valid OpenAPI 3.1):

| Extension | Where | Solves |
| --- | --- | --- |
| `x-depop-auth` | root | Turning the captured credential into a live request: header/cookie templates + generated values (`${uuid}`, `${now}`), plus the `verify` op `login` probes |
| `x-depop-replay` | root | Transport tuning: browser proxy, retry/recapture status codes, rate limits |
| `x-depop-resolve` | parameter / workflow arg | Dynamic enums sourced from another operation's response or bundled reference data |
| `x-depop-workflow` / `x-depop-args` | operation | Multi-step stateful flows (upload → poll → create) and their CLI flags |
| `x-depop-command` / `x-depop-result` / `x-depop-hidden` | operation | CLI projection: subcommand name, response path to print, hide metadata-only endpoints |

Full reference: `docs/SPEC.md`. Also see `docs/BROWSER-PROXY.md` and `docs/WORKFLOWS.md`.

### The spec

`spec/` = `auth.manifest.json` (capture rules) + `openapi.yaml` (API surface) + `README.md`
(how it works, how it was reverse-engineered, drift symptoms) + `reference/` (bundled
taxonomy JSON). No code. `packages/sdk/test/depop-listing.test.ts` asserts the real
`list`/`update` request bodies against it, so a spec edit that breaks them fails the suite.

### Agent skills

`skills/<name>/SKILL.md` (frontmatter: `name`, `description`, single-line YAML) are the
agent playbooks, installed via `depop skills add [<name>…]` into `.claude/skills` (or
`--global`, or `--dir <path>`). Installed skills carry a `.depop.json` provenance stamp so
`depop skills update` knows what it owns. `skills/depop/` is the root skill (session model:
login, `status --json`, exit codes) every other skill builds on and every install includes.

## Gotchas

- **`extension/types.d.ts` is a hand-maintained mirror**, not generated. It re-declares the
  auth-manifest shape as ambient types so the plain-JS extension can be `checkJs`-verified
  without importing `@depop/core`. `packages/core/test/extension-types-drift.test.ts`
  asserts every field name in `browser-auth-manifest.schema.json` also appears in
  `extension/types.d.ts` (name-level check, not structural). If you add/rename a field in the
  schema, update the mirror or the test fails — and if the extension intentionally doesn't
  read a field, add it to that test's `EXTENSION_IGNORES` set.
- **CLI ↔ extension wire contracts**: renaming any of these on one side silently breaks
  capture or the browser proxy — `id="depop-session"` and `window.__depopExtensionPresent`
  (`core/src/bootstrap-page.ts` ↔ `extension/content-localhost.js`), `__depop: "bridgeEvent"`
  (`extension/page-bridge.js` ↔ `extension/content-app.js`), `depopProxyError`
  (`extension/lib/proxy.js` ↔ the proxy server), and the loopback port `7878` duplicated in
  `core/src/proxy-server.ts` and `extension/lib/proxy.js`.
- **Two separate typecheck roots**: `tsconfig.json` (Bun/TS packages, `paths` mapping
  `@depop/core`/`@depop/sdk` to source) and `extension/tsconfig.json` (plain JS,
  `checkJs`, DOM + `chrome` types, no bundler). `bun run typecheck` runs both — a change that
  only touches one side can still break the other via the manifest schema.
- Never commit credentials, unredacted HARs, or capture bundles — `.gitignore` covers the
  obvious cases but double-check by hand. `redact.ts` (core) is the runtime guard for logs;
  it does not protect files you add manually.
- The credential store writes to `~/.depop/` at mode `0600`; taxonomy resolution caches to
  `~/.depop/cache/`. Both honor `DEPOP_HOME`. Tests that touch these paths should not assume
  a clean/writable `~/.depop` in CI — check how existing tests (e.g.
  `packages/core/test/capture-flow.test.ts`) isolate this.
- Debug env vars: `DEPOP_DEBUG` (dump a call's raw response), `DEPOP_DEBUG_DUMP=<path>`
  (write the full body), `DEPOP_DEBUG_STEPS` (trace workflow steps), `DEPOP_PROXY_PORT`.
- Bun workspaces (`packages/*`) — packages resolve `@depop/core`/`@depop/sdk` via
  `workspace:*`, and `tsconfig.json` additionally maps those specifiers straight to
  `src/index.ts` for typechecking without a build step. There is no per-package build; only
  `bun run build` (bundling `packages/cli/src/bin.ts`) exists, and it's only needed for the
  npm package (`prepack` runs it automatically).
- `bin/depop.cjs` is the Node launcher shim used by `npm install -g` / `npx` consumers; from
  a repo checkout, prefer `bun run depop …` (runs `packages/cli/src/bin.ts` directly via Bun,
  no build step).

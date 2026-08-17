<div align="center">

# depop&nbsp;cli

**Drive your logged-in Depop session from the terminal — for you and for agents.**

```bash
depop login
depop search "carhartt jacket" --conditions used_good --sizes M --json
```

[Concept](#the-idea) · [Quickstart](#quickstart) · [How it works](#how-it-works) · [Commands](#commands) · [Agent skills](#agent-skills) · [Docs](#documentation) · [Ethics](#ethics--scope)

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
![Bun](https://img.shields.io/badge/runtime-Bun-black)
![OpenAPI 3.1](https://img.shields.io/badge/spec-OpenAPI%203.1-black)

</div>

---

## The idea

Depop has no public API. But you're already logged into it in your browser.
**depop cli turns that session into a real API.**

It does three things:

1. **Captures** your existing browser session through a small Chrome extension
   (no passwords typed, no scraping — it reads the auth your browser already holds).
2. **Stores** only the minimal credential needed to replay requests.
3. **Replays** that session against Depop's own (reverse-engineered) API, and
   exposes each endpoint as a clean CLI command — JSON in, JSON out, agent-ready.

The design commitment: **the connector is data, not code.** Depop's API is
described as a standard **OpenAPI 3.1 document** (plus a few `x-depop-*`
extensions for what OpenAPI can't express) in [`spec/`](spec). The same rails
handle login, command dispatch, filters, pagination, and multi-step flows — so
when Depop changes, you edit the spec, not the engine.

```text
depop login                              # capture your Depop session via the browser
depop search "polo sweater" --sizes M --conditions used_good --json
depop list   --photo a.jpg --brand nike --type tshirts … --dry-run
depop me
```

---

## Quickstart

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (the runtime; the launcher tells you if it's missing)
- Google Chrome (for the capture extension)

### 1. Install

```bash
npm install -g depop-cli    # puts `depop` on your PATH
depop --help
```

Or zero-install: prefix every command with `npx -y depop-cli` instead of
`depop`. Working on the CLI itself? Clone the repo, `bun install`, and use
`bun run depop …`.

### 2. Load the capture extension (one time)

```bash
depop extension install
```

This copies the bundled extension to `~/.depop/extension` and walks you through
`chrome://extensions` → **Developer mode** → **Load unpacked**. Pin **depop cli**
— click its icon any time to see capture status. (From a repo checkout you can
load the [`extension/`](extension) folder directly.)

### 3. Log in

Make sure you're signed in to Depop in Chrome, then:

```bash
depop login
```

A localhost tab opens, then Depop's. The extension reads your session and hands
it back; the CLI validates it, probes it with a real call, and stores it under
`~/.depop/`. Confirm with:

```bash
depop status
```

### 4. Use it

```bash
depop --help                            # list the commands
depop search "vintage levis" --json     # call one
```

Use `--json` for machine-readable output (ideal for agents/scripts).

---

## How it works

```text
       ┌──────────┐   login    ┌──────────────┐   manifest   ┌────────────────┐
       │  depop   │──────────▶ │  Auth Broker │────────────▶ │  Chrome ext    │
       │   CLI    │            │  + Receiver  │ ◀──capture── │  (MV3, generic)│
       └────┬─────┘            └──────┬───────┘   bundle     └───────┬────────┘
            │                         │                              │ observes
            │ <command> [flags]       ▼                              ▼
            │                  ┌──────────────┐               ┌────────────────┐
            └────────────────▶ │     SDK      │               │   depop.com    │
                               │  • auth load │               │                │
                               │  • replay    │◀──────────────┤                │
                               │  • workflows │  browser-proxy └────────────────┘
                               └──────┬───────┘   (past Cloudflare)
                                      │ reads
                               ┌──────▼────────┐
                               │     spec/     │  openapi.yaml + auth.manifest.json
                               └───────────────┘
```

The design line:

> **The manifest defines _what_ to capture. The broker defines _how_ to
> capture. Applications consume _validated_ credentials.**

### The four moving parts

#### 1. The capture extension — [`extension/`](extension)

A **generic** MV3 Chrome extension with no site-specific code: it interprets
whatever `auth.manifest.json` the CLI hands it. During `depop login` it observes
the target tab (cookies via `chrome.cookies`, headers via `webRequest`, page
fetch/XHR via an injected page-bridge), decides when capture is complete from
the manifest's declarative rules, serializes a minimal credential bundle, and
posts it back to a loopback receiver. Click its toolbar icon to watch live status.

It only ever observes tabs tied to an active capture session; ordinary browsing
is never touched, and the session lives in memory and expires fast.

#### 2. The core — [`@depop/core`](packages/core)

The engine. The **broker** runs a capture session: it stands up a localhost
**receiver**, opens the browser, waits for the bundle, validates it, and writes a
minimal credential through the **credential store** (a file at `~/.depop/`, mode
`0600`; the interface is pluggable for keychain/secret-manager backends). It also
loads and validates the **OpenAPI spec**.

#### 3. The SDK — [`@depop/sdk`](packages/sdk)

The replay layer. It builds a request from an OpenAPI operation + your CLI flags
(query/path/body params, array `style`/`explode`, enums, defaults), applies the
`x-depop-auth` binding (headers, cookies, per-request `${uuid}` values), resolves
dynamic filter values against Depop's taxonomy endpoints (cached), runs the
request through the right **transport**, and maps the response. It also runs
multi-step **workflows**.

#### 4. The CLI — [`@depop/cli`](packages/cli)

The `depop` binary. Built-in verbs (`login`, `logout`, `status`, `skills`,
`extension`) plus **commands generated from the OpenAPI operations**. Flags come
from the operation's parameters; their allowed values come from `schema.enum`;
help is auto-generated. The CLI is a thin, faithful projection of the spec.

---

## Commands

| Command | What it does |
| --- | --- |
| `depop search "<query>" [filters]` | Search listings — size/brand/category/colour/condition/price filters, cursor pagination. |
| `depop me` | The logged-in user's profile. |
| `depop list --photo … [fields]` | List an item for sale (multi-step: upload photos → poll → create). |
| `depop update <slug> [fields]` | Edit an existing listing; photos and untouched fields are preserved. |
| `depop discount <slug> --percent <0,5-95>` | Put a listing on sale, change the discount depth, or remove it (`--percent 0`). |

`depop <command> --help` is generated from the spec — trust it over anything
written here. Anything that writes supports `--dry-run`.

---

## Why OpenAPI (and the `x-depop-*` extensions)

Depop's API is described as a **valid OpenAPI 3.1 document** —
`spec/openapi.yaml` passes `redocly lint` clean, so standard tooling reads it.

OpenAPI natively covers the surface every API shares: paths, methods,
multiple-choice fields (`enum`), repeatable params (`array` + `style`/`explode`),
and an auth inventory. What it genuinely **can't** express — and that's exactly
the reverse-engineering part — lives in spec-legal `x-depop-*` extensions
(conformant validators ignore unknown `x-` keys, so the doc stays valid OpenAPI):

| Extension | Solves |
| --- | --- |
| `x-depop-auth` | How the captured credential becomes a live request: header/cookie templates and **per-request generated values** (`${uuid}`, `${now}`). |
| `x-depop-resolve` | **Dynamic enums** whose valid values come from another endpoint's response, or bundled reference data (Depop's size/brand taxonomies). |
| `x-depop-replay` | Transport tuning OpenAPI doesn't model: the browser proxy, retry & re-capture status codes, rate limits. |
| `x-depop-workflow` | Multi-step stateful flows (upload → poll → create) that aren't a single request. |
| `x-depop-command` / `-result` / `-hidden` | CLI projection: the subcommand name, the response path to print, hiding metadata-only endpoints. |

See [`docs/SPEC.md`](docs/SPEC.md) for the full reference.

---

## Notable capabilities

### Getting past bot protection — the browser proxy

Depop sits behind a Cloudflare **managed challenge** (the "Just a moment" JS
interstitial). TLS impersonation alone can't solve it. So when the spec sets
`x-depop-replay.via_browser`, requests run **inside your already-logged-in
browser tab** — which Cloudflare already trusts — and the JSON is relayed back.
No headless browser, no challenge-solving service; it _is_ a real browser.
→ [`docs/BROWSER-PROXY.md`](docs/BROWSER-PROXY.md)

### Human-friendly filters — taxonomy resolution

A flag accepts either a wire id _or_ a human label, resolved against Depop's own
filter-metadata endpoints (fetched once, cached under `~/.depop/cache/`) or a
bundled JSON file. So `--sizes M` becomes the right internal id automatically,
and `depop search --help` shows real, current choices.

### Multi-step flows — workflows

A command can be a declarative sequence of steps with data flowing between them
(`foreach` with index pairing, `poll`-until, binary uploads, per-step transport,
pure-transform steps, and typed/derived body fields). "List an item" is
upload-each-photo → poll-until-processed → create-listing, expressed entirely in
the OpenAPI doc. `--dry-run` prints every planned request body without sending
anything. → [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md)

---

## Agent skills

The CLI ships **agent skills** — `SKILL.md` playbooks that teach an AI agent
when and how to drive it (preconditions, `--json` shapes, rate limits, safety
rules like "dry-run before posting publicly"). They live in [`skills/`](skills),
next to the spec they describe, so a fix to a drifting API and the playbook that
documents it travel in the same PR.

```bash
depop skills list                   # what's available
depop skills add                    # install into ./.claude/skills (project)
depop skills add search --global    # ~/.claude/skills (everywhere)
depop skills add --dir .agents/skills
depop skills update                 # refresh everything installed here
```

Every install includes the root `depop` skill — the session-model conventions
(login, `status --json`, exit codes) the others build on. Installed skills carry
a `.depop.json` provenance stamp so `update` knows what it owns.

Because skills are standard-format `SKILL.md` directories in a public GitHub
repo, generic skill installers (e.g. `npx skills add`) can fetch them too.

---

## Project layout

```text
depop-cli/
├── packages/
│   ├── core/        @depop/core — schemas, OpenAPI loader, credential store,
│   │                broker, receiver, proxy server
│   ├── sdk/         @depop/sdk — connector, transports, taxonomy resolver,
│   │                workflow runner, templating
│   └── cli/         @depop/cli — the `depop` binary
├── extension/       generic MV3 capture + browser-proxy runtime (plain JS, type-checked)
├── spec/            openapi.yaml + auth.manifest.json + reference/ — the connector
├── skills/          agent skills: depop (session model) · search
├── bin/             node launcher shim for npx/global installs
└── docs/            SPEC · BROWSER-PROXY · WORKFLOWS
```

Bun + TypeScript throughout (strict; the extension JS is `checkJs`-verified).
From a checkout everything runs on Bun directly — the only build step is
`bun run build`, which bundles the CLI into `dist/` for the npm package.

```bash
bun test            # run the test suite
bun run typecheck   # type-check everything (TS + extension)
bun run depop …     # run the CLI from source
```

---

## Documentation

| Doc | What it covers |
| --- | --- |
| [`docs/SPEC.md`](docs/SPEC.md) | How the spec is structured, the `x-depop-*` reference, and what to edit when Depop drifts. |
| [`docs/BROWSER-PROXY.md`](docs/BROWSER-PROXY.md) | How requests run inside a real browser tab to beat managed challenges. |
| [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md) | Multi-step flows: steps, `foreach`, `poll`, dry-run. |
| [`extension/README.md`](extension/README.md) | The capture extension internals. |
| [`spec/README.md`](spec/README.md) | The Depop connector, end to end: auth, endpoints, drift symptoms. |

---

## Ethics & scope

This is built for legitimate personal automation — driving an account _you_ are
logged into, on _your_ behalf.

- It operates **only** within a browser session the current user already controls.
  It does not bypass authorization or consent, and it never types or stores
  passwords.
- It persists the **minimum** credential needed to replay, stored locally with
  tight permissions; tokens and cookies are redacted in all logs.
- Unofficial APIs are operational contracts with drift detection — not stable
  guarantees, and not a license to abuse a service.
- Respect Depop's Terms of Service and rate limits. You are responsible for how
  you use it.

---

## Contributing

Run `bun test` and `bun run typecheck` before opening a PR. A good PR against
the spec includes a validated `openapi.yaml`, notes on how the change was
reverse-engineered, and **no committed credentials or unredacted HARs** (the
`.gitignore` guards the obvious cases — double-check).

## License

[MIT](LICENSE)

# The spec — how `depop` is defined

Every command, flag and request this CLI makes comes from `spec/`. There is no
per-endpoint TypeScript: when Depop's API changes, you edit the spec, not the
engine.

```
spec/
  auth.manifest.json            # what the extension captures in the browser
  openapi.yaml                  # the API surface (OpenAPI 3.1 + x-depop-*)
  reference/*.json              # bundled taxonomies (categories, size sets, …)
  README.md                     # how the connector works + drift symptoms
```

Validate as you go:

```bash
bun run depop --help              # lists commands (from OpenAPI operations)
bun run depop <cmd> --help        # lists flags  (from operation parameters)
bun test                          # spec-driven tests, incl. the listing bodies
```

The document is a **valid OpenAPI 3.1 doc** — `redocly lint spec/openapi.yaml`
passes — so standard tooling still reads it.

---

## Why OpenAPI (and where it stops)

OpenAPI already nails the parts every API has: paths, methods, query/path/body
params, **multiple-choice fields** (`schema.enum`), **repeatable params**
(`type: array` + `style`/`explode`), and an auth *inventory*.

What it genuinely **cannot** express — exactly the reverse-engineering parts —
lives in spec-legal `x-depop-*` extensions (conformant validators ignore unknown
`x-` keys, so the doc stays valid OpenAPI):

| Extension | Problem it solves |
| --- | --- |
| `x-depop-auth` (root) | How the captured credential becomes a live request: header/cookie templates and **per-request generated values** (`${uuid}`, `${now}`). An OpenAPI `securityScheme` only names the credential, never how to mint it. Also names the `verify` operation `depop login` probes. |
| `x-depop-replay` (root) | Transport tuning OpenAPI doesn't model: `via_browser` (run inside the logged-in tab, past Cloudflare), retry/recapture status codes, rate limit. |
| `x-depop-resolve` (on a parameter or workflow arg) | **Dynamic enums**: valid values come from *another operation's response* (sizes, brands, categories) or from `reference/*.json`, not a static list. JSON Schema `enum` is static literals only. |
| `x-depop-workflow` + `x-depop-args` (on an operation) | Multi-step stateful flows (upload → poll → create) behind one command, with their own CLI flags. See [`WORKFLOWS.md`](WORKFLOWS.md). |
| `x-depop-command` / `x-depop-result` / `x-depop-hidden` (on an operation) | CLI projection: the subcommand name, the response path to pretty-print, and hiding metadata-only endpoints. |

> Don't invent human-friendly aliases. Flags and their allowed values are
> **whatever the API supports**, read straight from the spec. `x-depop-resolve`
> exists only because the API itself serves the value list from another endpoint.

---

## `auth.manifest.json` — the browser half

Declares what the extension captures and when capture is complete: which cookies
to watch, which headers/page fetches to observe, the completion rule, and how
observations are serialized into credential fields. Its schema lives in
`packages/core/src/schemas/browser-auth-manifest.schema.json` (and is mirrored,
by hand, in `extension/types.d.ts`).

The serialized fields become the credential `x-depop-auth` consumes via
`${auth.<field>}`.

---

## `openapi.yaml` — the API half

Standard OpenAPI for the surface, `x-depop-*` for the rest:

```yaml
servers: [{ url: https://webapi.depop.com }]

x-depop-replay: { via_browser: true, recapture_on: [401, 419] }

x-depop-auth:
  required_fields: [access_token]
  verify: { operationId: me }
  headers:
    authorization: "Bearer ${auth.access_token}"
    x-request-id: "${uuid}"            # fresh per request

paths:
  /api/search/:
    get:
      operationId: search
      x-depop-result: objects           # pretty-print response.objects
      parameters:
        - name: q
          in: query
          required: true
          schema: { type: string }
        - name: condition                # closed vocabulary → enum
          in: query
          explode: true
          schema: { type: array, items: { type: string, enum: [new, used] } }
        - name: brandIds                 # dynamic taxonomy → resolve
          in: query
          explode: true
          schema: { type: array, items: { type: string } }
          x-depop-resolve:
            from: brandsById              # operationId that returns the list
            value_path: brands[].id
            label_path: brands[].name
  /api/brands/:
    get:
      operationId: brandsById
      x-depop-hidden: true               # metadata only — not a CLI command
```

- An operation with a command (via `x-depop-command`, else `operationId`)
  becomes `depop <command>`. Its `parameters` become flags; the first declared
  param also binds to the first positional, so `depop search "jacket"` works.
- `enum` (on the param or its array `items`) is validated and shown in `--help`.
- `x-depop-resolve` params accept **either** the wire id **or** a label; the SDK
  fetches the taxonomy once, caches it (`~/.depop/cache/`, default 24h), and
  translates.
- Array params serialize per OpenAPI `style`/`explode` (query default is
  `form`/`explode: true` → `?k=a&k=b`).

---

## When Depop drifts

Symptoms and their usual fix (see `spec/README.md` for the endpoint-by-endpoint
detail):

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Every call 401/419s right after login | session shape changed | re-check `auth.manifest.json` capture rules, then `depop login` |
| One command 4xxs, others fine | that endpoint's path/params moved | fix the operation in `openapi.yaml` |
| A `--sizes`/`--brandIds` label stops resolving | taxonomy response shape changed | fix `value_path`/`label_path`; clear `~/.depop/cache/` |
| `list`/`update` fails mid-flow | a workflow step's contract changed | run with `--dry-run`, then `DEPOP_DEBUG_STEPS=1` for the live bodies |

---

## Agent skills

`skills/<name>/SKILL.md` are the agent-facing playbooks — when to use a command,
preconditions (logged in?), the exact invocation with `--json`, how to read the
result, what to do on an auth error. Users install them with `depop skills add`.

Format: a directory per skill containing `SKILL.md` with **single-line** YAML
frontmatter:

```markdown
---
name: depop-<skill>
description: One sentence on what it does, then when an agent should reach for it (trigger phrases help).
---

# Title
…body: preconditions, the command, reading results, tips…
```

`name` is the directory the skill installs under — prefix it `depop-` so it
can't collide in a user's skills folder (the root session skill is just
`depop`). Defer flag lists to `--help` (they're generated from the spec and
would drift here); document the durable shape instead: auth precondition,
`--json`, result fields, rate limit, drift symptoms. Extra reference files can
sit next to SKILL.md — the whole directory is copied on install.

---

## Checklist for a spec change

- [ ] Capture the **minimum** artifacts — nothing you don't replay.
- [ ] `x-depop-auth.required_fields` covers everything the operations need.
- [ ] Secrets listed in `auth.manifest.json`'s `redact_fields` and `x-depop-auth.redact`.
- [ ] Closed value sets are `enum`; API-served value sets are `x-depop-resolve`.
- [ ] `x-depop-replay.recapture_on` distinguishes auth-expiry from other errors.
- [ ] Anything that writes was exercised with `--dry-run` first.
- [ ] The document still validates as OpenAPI 3.1.
- [ ] No unredacted HARs or credentials committed.

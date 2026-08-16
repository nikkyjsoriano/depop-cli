---
name: depop
description: Core conventions for the depop CLI — drives Depop's unofficial API by replaying the user's own captured browser session, so an agent can search listings, read the profile, and create or edit listings from the terminal. Read this before any depop command, or when the user mentions Depop, asks to log in, or a depop command fails with an auth error.
---

# depop — drive Depop from the terminal

`depop` replays a captured browser session against Depop's unofficial API, so
you can search, read, and act on Depop without an official API. Every
subcommand is generated from the bundled OpenAPI spec.

If `depop` is not on PATH, invoke every command as `npx -y depop-cli` instead
(e.g. `npx -y depop-cli search "…" --json`).

## The session model

- The credential is captured **once** from the user's own browser via the depop
  extension: `depop login`. This is interactive — the user must already be
  logged in to Depop in Chrome. Never type credentials yourself.
- Check state before calling anything:

  ```bash
  depop status --json    # { "logged_in": true, "state": "active", ... }
  ```

  If `logged_in` is false or `state` isn't `active`, ask the user to run
  `depop login`, then retry.
- `depop logout` forgets the stored session.

## Conventions

- `depop --help` lists the commands; `depop <command> --help` lists its flags.
  Both are generated from the spec — trust `--help` over any memorized flag list.
- **Always pass `--json`** when you consume output; the default output is for
  humans.
- Exit code 2 means you misused a flag (read the message); 1 is a runtime
  failure. An auth error usually means the session expired — re-login.
- Depop rate-limits. If a command reports throttling, slow down; don't
  loop-retry.
- Commands that change real-world state (`list`, `update`) support `--dry-run`.
  Dry-run first and confirm with the user before anything that posts publicly.

## Command playbooks

Detailed playbooks ship alongside this skill. Install them together:

```bash
depop skills add            # every skill
depop skills add search     # just one (the root skill always comes along)
```

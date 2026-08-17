---
name: depop-discount
description: Put a Depop listing on sale, change the discount depth, or remove it via the depop CLI. Use when the user wants to discount, put on sale, mark down, or reprice-via-percentage a Depop listing ("put my Nike jacket on sale", "20% off that listing", "end the sale on my Levi's").
---

# Discount a Depop listing

Agent-facing playbook for setting a listing's sale discount via `depop
discount`. If `depop` is not on PATH, invoke it as `npx -y depop-cli`.

## When to use

The user wants to start, change, or end a sale on one of their own Depop
listings — a percentage off the original price, not a new fixed price.

## Preconditions

- `depop login` has been run (check `depop status --json` → `logged_in` is
  true and `state` is `"active"`). If expired/absent, ask the user to run
  `depop login`.
- You need the listing's **slug** — the last path segment of the listing URL
  (`depop.com/products/<slug>/`). If you only have a search result, its `slug`
  field works directly.

## Command

```bash
depop discount <slug> --percent <0,5,10,...,95> --dry-run   # preview first
depop discount <slug> --percent 20                          # 20% off
depop discount <slug> --percent 0                           # remove the sale
```

`--percent` is required and only accepts `0` or a multiple of `5` up to `95`
— that's Depop's own limit, not this tool's. `0` removes the discount and
restores the original price; there's no separate remove command.

Percentages are always taken off the **original** price, and setting a new
one **replaces** any existing discount rather than compounding it — running
`--percent 20` on a listing already at 40% off moves it to 20% off the
original price, not 20% off the already-discounted price.

## Reading results

Pass `--json`. The result is the discount endpoint's own response for that
listing: `undiscounted_price`, `discounted_price`, `discount_percentage`,
`discount_type`. There's no separate read step to fetch afterward.

## Tips

- Always `--dry-run` first and confirm the listing/percentage with the user
  before a live call — this changes a real, public listing and (at 10% off or
  more) notifies everyone who liked the item.
- If you don't have the slug, `depop search "<query>" --json` (search your own
  shop by adding a brand/keyword filter) or ask the user for the listing URL.
- If you get an auth error, the session expired — tell the user to re-run
  `depop login`.

---
name: depop-offers
description: Read Depop offer activity and accept buyer offers via the depop CLI — list which listings have offers, see who liked an item, and accept an offer by id. Use when the user mentions Depop offers, asks what offers they have, or wants to accept an offer ("any offers on my sneakers?", "accept that offer").
---

# Depop offers

Agent-facing playbook for the `depop offers` family. If `depop` is not on PATH,
invoke it as `npx -y depop-cli`.

## What exists today

```bash
depop offers --json        # your listings that have offers, with a count each
depop likers --json        # buyers who liked an item but haven't offered
depop offer-accept <slug> --offer <uuid>
```

That is the whole surface. Reading the individual offers on a listing,
declining, and countering are **not implemented** — see "Gaps" below. Don't
invent flags for them.

## Preconditions

- `depop login` has been run (`depop status --json` → `logged_in: true`,
  `state: "active"`). If not, ask the user to run `depop login`.
- Chrome must be running with the depop extension loaded and the user's Depop
  session live — every request is proxied through an authenticated tab.

## Reading

`depop offers --json` returns one row per listing+variant:
`product_id`, `description`, `price_amount`, `price_currency`, `variant_set`,
`variant_id`, `offer_count`.

**`offer_count` is a string and saturates.** A busy listing reports `"10+"`,
not a number. Never parse it as an int, and never present "10+" as "10".

`depop likers --json` returns buyers who liked an item but haven't offered:
`sender` (`id`, `username`, `firstName`, `lastName`, `country`), `product`,
`date`, `isNew`. It is account-wide with no per-listing filter, so filter on
`product.id` yourself. It is cursor-paginated and this command returns only the
first page.

## Accepting

```bash
depop offer-accept <slug> --offer <uuid> --dry-run   # preview first
depop offer-accept <slug> --offer <uuid>
```

`--slug` is the last path segment of the listing URL. `--offer` is a UUID and is
repeatable, so one call can accept several offers on the same listing.

**Where offer ids come from:** there is no command that lists them yet. Get them
from the Depop web UI (Selling Hub → Offers → Review) and ask the user to paste
them. Do not guess a uuid, and do not try to derive one from `depop offers` —
that command returns product ids, not offer ids.

## Cautions

- **Accepting is a real sale with no undo**, and it is **not exclusive**:
  it does not cancel or expire the other offers on that listing, and a listing
  can hold several accepted offers at once. Accepting more than one offer on a
  one-of-one item **will oversell it**. Accept one offer per item unless the
  user has stock.
- Before accepting, check whether the listing already has an accepted offer
  awaiting checkout — there may already be a buyer mid-purchase, possibly at a
  higher price. That state is only visible in the Depop web UI today.
- Accepting gives the buyer roughly 24 hours to check out; the `expires_at` on
  the response is that window, not the original offer's expiry.
- `--offer` batches have **no error tolerance**. A failure on the third of five
  aborts with the first two already accepted. Prefer one offer per call.
- Always `--dry-run` first and show the user the listing and offer id before the
  live call. There is no confirmation prompt in the CLI — dry-run plus asking
  the user is the entire safety story.
- Auth errors mean the session expired: ask the user to re-run `depop login`.

## Gaps

Not implemented, each tracked as a repo issue. If the user asks for one of
these, say it isn't supported yet and point them at the Depop app rather than
improvising:

- **Listing the individual offers on a listing.** The endpoint returns HTTP 400
  when replayed outside the browser; cause unknown.
- **`offer-decline` / `offer-counter`.** The write endpoint takes a
  `seller_response` field and only `ACCEPT` was ever captured. The other values
  are guesses and were deliberately left out.
- **Sending offers to all likers.** `depop likers` lists the candidates, but the
  send endpoint was never captured.

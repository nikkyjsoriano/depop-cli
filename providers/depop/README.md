# Depop connector

Drives Depop's web API using your logged-in browser session.

```bash
mastro login depop
mastro depop search "holiday knit jumper men" --sizes M
mastro depop search "carhartt jacket" --conditions used_good --colours green --sortBy priceAscending
mastro depop search "vintage tee" --brandIds nike --priceMax 50 --isDiscounted --json
mastro depop me
```

The connector is described by [`openapi.yaml`](openapi.yaml) (a valid OpenAPI 3.1
document) plus [`auth.manifest.json`](auth.manifest.json) for the browser capture.

## How auth works

Depop's web app stores auth in two cookies on `depop.com`:

| Cookie         | Use                                  |
| -------------- | ------------------------------------ |
| `access_token` | Bearer token for the web API         |
| `user_id`      | Your numeric account id (`x-user-id`)|

`access_token` is **HttpOnly**, so page JavaScript can't read it — the mastro
extension reads it via `chrome.cookies`. `mastro login depop` opens Depop, waits
until both cookies exist, and stores them (token redacted in logs).

Each request also sends client-generated `depop-device-id` / `depop-session-id`
/ `depop-search-id` UUIDs — the spec mints these per request via `${uuid}`.

## How replay works

The web API sits behind a Cloudflare **managed challenge** (the "Just a moment"
JS interstitial). TLS impersonation alone can't solve it — even a perfect Chrome
handshake with the captured cookies gets a `403`. So Depop sets
`x-mastro-replay.via_browser: true`, and mastro runs the request **inside your
logged-in browser tab** (which already cleared the challenge) via the extension.
See [`docs/BROWSER-PROXY.md`](../../docs/BROWSER-PROXY.md).

**Requirement:** the mastro extension must be installed/enabled and you must have
a logged-in **depop.com tab open** (mastro will open one if needed). No
`curl-impersonate` needed.

```
mastro depop search ...
  → mastro proxy server (127.0.0.1:7878)
  → extension runs fetch() in your depop.com tab (past Cloudflare)
  → JSON back to the CLI
```

## Commands

| Command  | Endpoint / flow                                 |
| -------- | ----------------------------------------------- |
| `search` | `GET https://www.depop.com/presentation/api/v1/search/products/` |
| `me`     | `GET /api/v1/users/{user_id}/` — ⚠️ see host note (currently 404s) |
| `list`   | multi-step workflow: upload photos → poll → create listing |
| `update` | read + `PUT https://webapi.depop.com/presentation/api/v1/products/by-slug/{slug}/` — edit a listing, photos preserved |

> **Host split (important — it's the #1 source of 404s).** Depop serves its API
> from **two** hosts. `www.depop.com` answers the `/presentation/*` search path.
> Everything under `/api/*` and `/internal/*` — picture upload, validate,
> batch-poll, `users/{id}` — plus the listing-create POST lives on
> **`webapi.depop.com`**. Hitting an `/api/*` path on `www` returns a Next.js
> **404 HTML page** (`__next_error__`), not JSON — that HTML 404 is the signature
> of "right path, wrong host." Workflow steps that need the webapi host set an
> explicit `request.url`.
>
> ⚠️ **Known gap:** the `me` command is a plain (non-workflow) operation, so it
> can't set a per-step URL and still hits `www` → 404. It needs an operation-level
> host override (the workflow `list` steps already work around this with explicit
> `request.url`s).

### Listing an item

```bash
mastro depop list \
  --photo front.jpg --photo back.jpg \
  --brand polo-ralph-lauren \
  --department menswear --type tshirts --size M \
  --condition used_good --colour navy \
  --price 25 \
  --description "Vintage Polo tee ... #ralphlauren #vintage" \
  --address-id 42475963 --address "San Francisco, United States" \
  --lat 37.779026 --lng -122.419906 \
  [--dry-run]
```

- **Photos must be square JPEGs** (the `depop-list-item` skill handles
  HEIC→JPEG + cropping; mastro uploads them as-is).
- `variant_set`, `gender`, and the size **`variant`** are **derived** from
  `--department`/`--type`/`--size` via bundled reference data
  (`reference/categories.json`, `reference/department_gender.json`,
  `reference/size_variants.json`) — you don't pass internal ids. The size maps
  through two keyed lookups: `(department/type)→size_set`, then
  `(size_set/size)→variant` member id, which becomes the `variants` map on the
  listing so the size attaches correctly.
- **`--dry-run` builds and prints every request body without uploading or
  posting** — always dry-run first. See [`docs/WORKFLOWS.md`](../../docs/WORKFLOWS.md).
- **Boost is never enabled.** The create body pins `boost` to `inactive` and
  there is no flag for it; making boost a real choice is separate work.
- Depop's payload has no title field. The listing text is `description`, and its
  first line is what reads as the title.

### Updating a listing

Edits everything except photos. Only the flags you pass change; everything else
is carried over from the listing as it is now.

```bash
mastro depop update seller-asics-gel-1130-543c --price 110 --dry-run
mastro depop update seller-asics-gel-1130-543c --description "ASICS GEL-1130 #asics #sneakers"
mastro depop update seller-asics-gel-1130-543c --department womenswear --type trainers --size 6
mastro depop update seller-asics-gel-1130-543c --address-id 26518315
```

**Takes the listing slug, not the id.** The slug is the last path segment of the
listing URL (`depop.com/products/<slug>/`), because that is what the edit
endpoint is keyed by.

Editable: `--price`, `--currency`, `--description`, `--brand`, `--condition`,
`--colour`, `--department`, `--type`, `--size`, `--quantity`, `--age`,
`--style`, `--source`, `--address`, `--lat`, `--lng`, `--address-id`.

#### How it works, and why it reads first

Depop's edit endpoint **replaces** the listing. The web app GETs the whole
product, then PUTs the whole object back with every field present:

```
GET  https://webapi.depop.com/presentation/api/v1/products/by-slug/<slug>/edit-listing/
PUT  https://webapi.depop.com/presentation/api/v1/products/by-slug/<slug>/   -> 204 No Content
```

There is no partial write. Anything missing from a PUT is cleared, so this
command does the same read-modify-write the browser does: it reads the listing,
merges your flags over it, PUTs it back, then reads it again and prints the
result (the PUT itself answers 204 with no body).

That is also why **photos survive**. `picture_ids` is carried through verbatim
on every edit. An edit that forgot them would delete every photo on the listing.

The read and the write disagree on names, and the flow maps between them:

| Read (`edit-listing`) | Write (`PUT`) |
| --------------------- | ------------- |
| `variant_set_id` | `variant_set` |
| `shipping_methods[].parcel_size_id` | `shipping_methods[].parcel_size` |
| `pictures[{id, url}]` | `picture_ids[]` |
| `pricing.original_price.total_price` | `price_amount` |
| `pricing.currency` | `price_currency` |

`address` and `geo_position_lat/lng` are **not in the read at all**. The web app
recomputes them from the listing's country against its own static countries
asset, so this connector does the same from
[`reference/country_geo.json`](reference/country_geo.json). Depop's own edit
form resets a listing's coordinates to the country centroid on every save, so
matching it is matching reality. Pass `--address --lat --lng` to override.

#### Rules

- **Some fields go out as a whole group or not at all**, because that is how
  they sit on the listing. Category is `--department` plus `--type`, and size is
  the `variants` map derived from both, so all three travel together (the same
  derivation `list` uses). The stock count lives inside that same map, so
  `--quantity` needs `--size`. Location is one group, so `--address`, `--lat`
  and `--lng` travel together. The price is an amount plus a currency, so
  `--currency` needs `--price`. Passing part of a group is a usage error rather
  than a silent drop.
- **An update with no field flags is refused.** Replacing the listing with
  itself is not a harmless no-op.
- **Never sent:** `boost` (an edit payload has no boost field at all; boosting
  is a separate endpoint mastro never calls) and the create-time
  `listing_lifecycle_id` / `persistent_id`.
- Depop's payload has no title field. The listing text is `description`, and its
  first line is what reads as the title, so retitling is a `--description` edit.
- An empty value counts as "not passed", so `--description ""` does not clear
  the text.

#### Not editable here, and why

- **Photos.** Preserved, not replaceable. Swapping them needs the upload
  pipeline the `list` workflow already has, and is tracked separately.
- **Parcel size.** Depop derives `national_shipping_cost` from it (`medium` was
  $3.99 on the captured listing). Changing the size without recomputing the cost
  would advertise the wrong shipping price, and picking the new cost needs a
  lookup against `shipping/providers/depop/` that this flow cannot express yet.
  `--address-id` is safe on its own and keeps the rest of the block.
- **Kidswear.** Moving a listing into or out of kidswear needs `is_kids` sent
  alongside the department. The value is carried over from the read, so the
  department can change without it following.
- **Attributes.** The edit read does not return them, so they cannot be
  preserved and are sent as `{}`, matching the captured payload.

> Reverse-engineered from a real edit captured through depop.com's seller form
> on 2026-08-13. `packages/sdk/test/depop-listing.test.ts` pins the exact body
> field for field, so drift shows up in the test suite rather than on a live
> listing. **Dry-run first and check the body.**
>
> ⚠️ **Not covered by that capture:** the listing edited had no active discount.
> A listing on sale carries `pricing.discounted_price` alongside the original,
> and this flow sends the original as `price_amount`, on the assumption the
> discount is a separate object that survives the write. That has not been
> verified. Editing a discounted listing could drop the sale, so check one by
> hand before trusting it.

### Search filters

Every filter from the website's filter bar is a flag, generated from the spec:

| Flag             | Wire param     | Notes |
| ---------------- | -------------- | ----- |
| `--what`         | `what`         | required search text |
| `--categories`   | `categories`   | repeatable; id or label (resolved via `categoryFilters`) |
| `--brandIds`     | `brandIds`     | repeatable; id or brand name (resolved via `brandsById`) |
| `--sizes`        | `sizes`        | repeatable; composite id or label e.g. `M` (resolved via `sizeFilters`) |
| `--colours`      | `colours`      | repeatable; enum (black, grey, white, …) |
| `--conditions`   | `conditions`   | repeatable; enum (brand_new, used_good, …) |
| `--priceMin/Max` | `priceMin/Max` | numeric |
| `--isDiscounted` | `isDiscounted` | boolean; "on sale" |
| `--sortBy`       | `sortBy`       | relevance \| priceAscending \| priceDescending \| newlyListed |
| `--limit`        | `limit`        | results per page (default 24) |
| `--after`        | `after`        | pagination cursor (`page_info.last` of the previous page) |

The `sizes` / `brandIds` / `categories` value lists are **fetched from Depop's
own filter-metadata endpoints** (`sizeFilters`, `brandsById`, `categoryFilters`,
declared `x-mastro-hidden` in the spec) and cached under
`~/.mastro/cache/depop/`, so `--sizes M` resolves to the wire id `54.4`
automatically.

## Status & drift

`status: reverse_engineered` — observed from browser traffic, can change without
notice. If `search` starts returning Cloudflare HTML or a shape without an
`objects` array:

1. `mastro login depop` (most failures are an expired session → `401`/`419`).
2. Capture a fresh HAR from depop.com's Network tab and diff the
   `search/products` request against `openapi.yaml`.

> Reverse-engineered from a real HAR (`~/Downloads/www.depop.com.har`) plus the
> earlier `depop-cli`. The HAR only exercised the `sizes` filter; the other
> param names (`brandIds`, `colours`, `conditions`, `priceMin/Max`,
> `isDiscounted`, `sortBy`) were recovered from the response payloads. The
> `sortBy` enum values should be re-verified on the next capture.

> The write flow (image upload + listing creation), ported from the original
> `depop-cli`, **is** implemented as the `list` workflow (verified live). Its
> createListing body must match Depop's exactly or the endpoint returns an opaque
> `400` ("Request failed with status code 400") — the ground-truth shape is
> `depop-cli`'s `build_listing_body` + the appended `picture_ids`. Watch these on
> drift: the `webapi.depop.com` host for the write endpoints, integer
> `picture_ids` (extracted from the slot S3 URL), numeric `geo_position_*` /
> `ship_from_address_id` / `variant_set`, `quantity: null` when `variants` is set,
> and `is_kids`.

> The `update` flow is derived from that same create body but has **not** been
> confirmed against a captured edit (see the warning above). Three known gaps for
> the next capture: `is_kids` is never sent, so moving a listing into or out of
> kidswear may not stick; `quantity` is sent as passed rather than as create's
> `null`-when-sized convention; and `national_shipping_cost`, which create sends
> alongside `shipping_methods`, is never sent, so a shipping edit may need it.

/**
 * The Depop `offers` command family, run against the real provider spec.
 *
 * Pinned to a live capture of the seller hub's Offers page
 * (depop.com/sellinghub/offers/, 2026-08-17). Every endpoint below was observed
 * on the wire, and `offers` / `likers` were additionally re-run live against a
 * real session:
 *
 *   GET  /presentation/api/v1/offers/me/products/          {objects, page_info}
 *   GET  /presentation/api/v1/products/<pid>/offers/       individual offers (fixed 2026-08-20, issue #14)
 *        ?active=true&include_size=true&variant_id=<n>
 *   GET  /api/v1/user/likes/notifications/                 {meta, actionableLikes}
 *   POST /presentation/api/v1/products/<pid>/offers/<oid>/ {"seller_response":"ACCEPT"}
 *   POST /presentation/api/v1/offers/<oid>/                counter — a DIFFERENT endpoint
 *        (no product_id); confirmed live 2026-08-20, but its body was not
 *        captured (the browser extension's network logger missed the write).
 *
 * `offer_id` is a uuid string, not an int, and the summary's `offer_count` is a
 * string that saturates at "10+" — both are pinned below so a future spec edit
 * can't quietly start coercing them.
 *
 * `offer-list` reads the individual offers on a listing (fixed 2026-08-20,
 * issue #14 — see the capture notes in openapi.yaml). `offer-decline` is
 * deliberately absent again: it was briefly shipped on the assumption it
 * mirrors `offer-accept`'s shape, but COUNTER turning out to be a wholly
 * different endpoint broke that assumption, so it's held back pending its own
 * capture. `offer-counter` exists in the spec but has no body at all yet — a
 * structural placeholder pending a live capture — see the block comment above
 * `/x-depop/offer-counter` in openapi.yaml. Do not test guessed field names
 * for it here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { parseOpenApi, type OpenApiSpec } from "@depop/core";
import { WorkflowRunner } from "../src/index.ts";

const SPEC_DIR = join(import.meta.dir, "../../../spec");
const SPEC_PATH = join(SPEC_DIR, "openapi.yaml");

interface PlannedStep {
  step: string;
  method: string;
  url: string;
  body: Record<string, unknown>;
}

function depopSpec(): OpenApiSpec {
  return parseOpenApi(readFileSync(SPEC_PATH, "utf8"));
}

function loadSpecFile(rel: string): unknown {
  return JSON.parse(readFileSync(join(SPEC_DIR, rel), "utf8"));
}

const SLUG = "seller-example-item-abcd";
const PRODUCT_ID = 858417177;
const OFFER_ID = "7bf8388b-f5f4-4a02-a6c9-5c387163e1d3";
const OTHER_OFFER_ID = "0455978b-5574-4f05-a7d2-0e4076d8f1e0";

/** The edit-listing read, only ever used here to resolve slug -> product id. */
const CURRENT_LISTING = {
  id: PRODUCT_ID,
  slug: SLUG,
  pricing: { currency: "USD", original_price: { total_price: "160.00" } },
};

/** GET /presentation/api/v1/offers/me/products/ — live envelope. */
const MY_OFFERS = {
  objects: [
    {
      product_id: PRODUCT_ID,
      description: "New Balance 1906R Rain Cloud",
      price_amount: "120.00",
      price_currency: "USD",
      variant_set: 77,
      variant_id: 10,
      // A string, and it saturates — see the test below.
      offer_count: "9",
    },
    {
      product_id: 858846841,
      description: "ASICS Gel-1130 White/Blue Fade",
      price_amount: "74.25",
      price_currency: "USD",
      variant_set: 77,
      variant_id: 5,
      offer_count: "10+",
    },
  ],
  page_info: { has_more: false },
};

const VARIANT_ID = 10; // matches MY_OFFERS's PRODUCT_ID row

/** GET /presentation/api/v1/products/<pid>/offers/?active=true&include_size=true&variant_id=<n> */
const OFFERS_ON_LISTING = {
  product_id: PRODUCT_ID,
  product_description: "New Balance 1906R Rain Cloud",
  product_created_on: "2026-01-05T12:00:00Z",
  picture_data: { id: 1, url: "https://media.depop.com/b0/example.jpg" },
  prices: { original_price: "120.00", discounted_price: null, current_price: "120.00" },
  variant_set: 77,
  variant_id: VARIANT_ID,
  size: "M",
  listing_stats: { created_date: "2026-01-05T12:00:00Z", likes_count: 4, recent_offers_count: 9 },
  offers: [
    {
      offer_id: OFFER_ID,
      offerer_id: 390509549,
      offerer_username: "buyer_one",
      offerer_first_name: "Jamie",
      offer_value: "103.00",
      offer_currency: "USD",
      expires_at: "2026-08-18T23:09:33.839650946Z",
      offer_display_status: "RECEIVED",
      can_make_counter_offer: true,
      sellers_lowest_offer_value: "100.00",
    },
  ],
};

/** POST .../offers/<oid>/ — the live accept response. */
function respondedOffer(status: string): unknown {
  return {
    offer_id: OFFER_ID,
    offerer_id: 390509549,
    offerer_username: "buyer_one",
    offer_value: "103.00",
    offer_currency: "USD",
    expires_at: "2026-08-18T23:09:33.839650946Z",
    offer_display_status: status,
    can_make_counter_offer: false,
    offerers_highest_offer_value: "103.00",
  };
}

async function plan(command: string, args: Record<string, unknown>): Promise<PlannedStep[]> {
  const spec = depopSpec();
  const runner = new WorkflowRunner({
    spec,
    authHeaders: () => ({ authorization: "Bearer tok" }),
    baseContext: () => ({ auth: { access_token: "tok" }, uuid: () => "fixed-uuid" }),
    apiTransport: async () => {
      throw new Error("dry run must not send");
    },
    loadFile: loadSpecFile,
    dryRun: true,
  });
  const op = spec.byCommand(command)!;
  const result = (await runner.run(op, args)) as { planned_requests: PlannedStep[] };
  return result.planned_requests;
}

/**
 * Run an offers command against a mock Depop that answers each captured
 * endpoint with its real response shape.
 */
async function run(
  command: string,
  args: Record<string, unknown>,
): Promise<{ sent: { method: string; url: string; body?: unknown }[]; result: unknown }> {
  const spec = depopSpec();
  const sent: { method: string; url: string; body?: unknown }[] = [];
  const runner = new WorkflowRunner({
    spec,
    authHeaders: () => ({ authorization: "Bearer tok" }),
    baseContext: () => ({ auth: { access_token: "tok" }, uuid: () => "fixed-uuid" }),
    loadFile: loadSpecFile,
    apiTransport: async () => ({
      name: "mock",
      send: async (req: { method: string; url: string; body?: unknown }) => {
        const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        sent.push({ method: req.method, url: req.url, body });
        const ok = (payload: unknown) => ({
          status: 200,
          headers: {},
          text: async () => JSON.stringify(payload),
        });
        if (req.url.endsWith("/edit-listing/")) return ok(CURRENT_LISTING);
        if (req.url.endsWith("/offers/me/products/")) return ok(MY_OFFERS);
        if (req.method === "GET" && req.url.includes("/offers/?active=true&include_size=true&variant_id=")) {
          return ok(OFFERS_ON_LISTING);
        }
        if (req.url.endsWith("/likes/notifications/")) {
          return ok({ meta: { cursor: "abc", hasMore: false }, actionableLikes: [{ isNew: true }] });
        }
        // POST .../offers/<oid>/
        const response = (body as { seller_response: string }).seller_response;
        const status = response === "ACCEPT" ? "ACCEPTED" : response === "DECLINE" ? "DECLINED" : response;
        return ok(respondedOffer(status));
      },
    }),
  });
  const result = await runner.run(spec.byCommand(command)!, args);
  return { sent, result };
}

// --- reads -----------------------------------------------------------------

test("offers reads the account-wide summary and unwraps the objects envelope", async () => {
  const { sent, result } = await run("offers", {});
  expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
    "GET https://webapi.depop.com/presentation/api/v1/offers/me/products/",
  ]);
  expect(result).toEqual(MY_OFFERS.objects);
});

test("offer_count stays a string so the '10+' saturation survives", async () => {
  const { result } = await run("offers", {});
  const counts = (result as { offer_count: unknown }[]).map((o) => o.offer_count);
  expect(counts).toEqual(["9", "10+"]);
});



test("likers reads the account-wide notifications feed", async () => {
  const { sent } = await run("likers", {});
  expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
    "GET https://webapi.depop.com/api/v1/user/likes/notifications/",
  ]);
});

test("offer-list resolves product id and variant id, then reads the individual offers", async () => {
  const { sent, result } = await run("offer-list", { slug: SLUG });
  expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
    `GET https://webapi.depop.com/presentation/api/v1/products/by-slug/${SLUG}/edit-listing/`,
    "GET https://webapi.depop.com/presentation/api/v1/offers/me/products/",
    `GET https://webapi.depop.com/presentation/api/v1/products/${PRODUCT_ID}/offers/?active=true&include_size=true&variant_id=${VARIANT_ID}`,
  ]);
  expect(result).toEqual(OFFERS_ON_LISTING);
});

test("offer-list surfaces offer_display_status and can_make_counter_offer untouched", async () => {
  const { result } = await run("offer-list", { slug: SLUG });
  const [offer] = (result as { offers: { offer_display_status: string; can_make_counter_offer: boolean }[] }).offers;
  expect(offer!.offer_display_status).toBe("RECEIVED");
  expect(offer!.can_make_counter_offer).toBe(true);
});

test("a dry-run plans offer-list's reads without sending", async () => {
  const steps = await plan("offer-list", { slug: SLUG });
  // "variant" is a pure transform (no operationId) so it never sends a request.
  expect(steps.map((s) => s.step)).toEqual(["current", "mine", "read"]);
});

// --- writes ----------------------------------------------------------------

test("offer-accept posts the captured body to the product+offer path", async () => {
  const { sent, result } = await run("offer-accept", { slug: SLUG, offer: [OFFER_ID] });
  expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
    `GET https://webapi.depop.com/presentation/api/v1/products/by-slug/${SLUG}/edit-listing/`,
    `POST https://webapi.depop.com/presentation/api/v1/products/${PRODUCT_ID}/offers/${OFFER_ID}/`,
  ]);
  expect(sent[1]!.body).toEqual({ seller_response: "ACCEPT" });
  // foreach collects results, so a single accept still returns a one-element array.
  expect(result).toEqual([respondedOffer("ACCEPTED")]);
});

test("offer-accept fans out one POST per repeated --offer, in order", async () => {
  const { sent } = await run("offer-accept", { slug: SLUG, offer: [OFFER_ID, OTHER_OFFER_ID] });
  const posts = sent.filter((s) => s.method === "POST");
  expect(posts.map((p) => p.url)).toEqual([
    `https://webapi.depop.com/presentation/api/v1/products/${PRODUCT_ID}/offers/${OFFER_ID}/`,
    `https://webapi.depop.com/presentation/api/v1/products/${PRODUCT_ID}/offers/${OTHER_OFFER_ID}/`,
  ]);
  // The listing is read once, not once per offer.
  expect(sent.filter((s) => s.method === "GET")).toHaveLength(1);
});

// --- dry run / spec invariants ---------------------------------------------

test("a dry-run plans the read and the write without sending", async () => {
  const steps = await plan("offer-accept", { slug: SLUG, offer: [OFFER_ID] });
  expect(steps.map((s) => s.step)).toEqual(["current", "accept"]);
  expect(steps[1]!.body).toEqual({ seller_response: "ACCEPT" });
});

function writeStep(spec: OpenApiSpec, command: string, operationId: string) {
  const op = spec.byCommand(command)!;
  const workflow = op.operation["x-depop-workflow"] as {
    steps: { operationId?: string; request?: { body?: Record<string, unknown> } }[];
  };
  return workflow.steps.find((s) => s.operationId === operationId)!;
}

test("offer-accept discriminates on seller_response", () => {
  const spec = depopSpec();
  expect(writeStep(spec, "offer-accept", "offerRespond").request!.body!.seller_response).toBe("ACCEPT");
});

test("offer-counter exists but has no body at all yet — endpoint confirmed, request shape is not", () => {
  const spec = depopSpec();
  expect(spec.byCommand("offer-counter")).toBeDefined();
  const counter = writeStep(spec, "offer-counter", "offerCounterRespond");
  expect(counter.request!.body).toBeUndefined();
  // Deliberately NOT asserting a price field here — fill this test in once
  // the live capture (see the block comment above offer-counter) lands.
});

test("offer-decline and offer-review are not command names — guessed/rejected verbs stay out until captured", () => {
  const spec = depopSpec();
  expect(spec.byCommand("offer-decline")).toBeUndefined();
  expect(spec.byCommand("offer-review")).toBeUndefined();
});

test("the offer flag is repeatable and required on offer-accept", () => {
  const spec = depopSpec();
  const args = spec.byCommand("offer-accept")!.operation["x-depop-args"] as {
    name: string;
    required?: boolean;
    multiple?: boolean;
  }[];
  const offer = args.find((a) => a.name === "offer")!;
  expect(offer.required).toBe(true);
  expect(offer.multiple).toBe(true);
  expect(args.find((a) => a.name === "slug")!.required).toBe(true);
});

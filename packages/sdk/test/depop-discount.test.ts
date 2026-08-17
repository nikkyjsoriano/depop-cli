/**
 * The Depop `discount` workflow, run against the real provider spec.
 *
 * Pinned to a live capture of the seller hub's "Discount" bulk-action tool
 * (depop.com/sellinghub/selling/active/, 2026-08-16): a PATCH to
 * `/api/v2/discounts/` keyed by numeric product id, not slug. Unlike `update`
 * (see depop-listing.test.ts), the discount is not part of the product
 * object — it's a wholly separate resource — which is why an `update` never
 * carries discount fields at all.
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

/** The edit-listing read, shaped exactly as depop-listing.test.ts's fixture. */
const CURRENT_LISTING = {
  id: 111222333,
  slug: "seller-example-item-abcd",
  pricing: {
    currency: "USD",
    original_price: { total_price: "100.00" },
  },
};

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
 * Run `discount` for real against a mock Depop: the read returns
 * CURRENT_LISTING, the PATCH answers with the resulting discount state (the
 * same shape the live endpoint returned on capture). Returns every request
 * made plus the workflow's final result.
 */
async function runDiscount(
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
        if (req.method === "GET") {
          return { status: 200, headers: {}, text: async () => JSON.stringify(CURRENT_LISTING) };
        }
        // PATCH /api/v2/discounts/ — mirror the live response shape.
        const [{ product_id, discount_percentage }] = body as [{ product_id: number; discount_percentage: number }];
        const original = 100;
        const discounted = (original * (1 - discount_percentage / 100)).toFixed(2);
        return {
          status: 200,
          headers: {},
          text: async () =>
            JSON.stringify({
              products: [
                {
                  product_id,
                  undiscounted_price: original.toFixed(2),
                  discounted_price: discounted,
                  discount_percentage,
                  discount_type: "PERCENTAGE",
                },
              ],
            }),
        };
      },
    }),
  });
  const result = await runner.run(spec.byCommand("discount")!, args);
  return { sent, result };
}

const SLUG = "seller-example-item-abcd";

test("discount resolves the slug to a numeric product id before writing", async () => {
  const { sent } = await runDiscount({ slug: SLUG, percent: "30" });
  expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
    `GET https://webapi.depop.com/presentation/api/v1/products/by-slug/${SLUG}/edit-listing/`,
    "PATCH https://webapi.depop.com/api/v2/discounts/",
  ]);
});

test("applying a discount sends the product id and percentage as a single-element array of numbers", async () => {
  const { sent } = await runDiscount({ slug: SLUG, percent: "30" });
  const patch = sent.find((s) => s.method === "PATCH")!;
  expect(patch.body).toEqual([{ product_id: 111222333, discount_percentage: 30 }]);
});

test("percent 0 removes the discount, same endpoint, no separate delete", async () => {
  const { sent } = await runDiscount({ slug: SLUG, percent: "0" });
  const patch = sent.find((s) => s.method === "PATCH")!;
  expect(patch.body).toEqual([{ product_id: 111222333, discount_percentage: 0 }]);
});

test("the command returns the write's own response, not a separate read-back", async () => {
  const { sent, result } = await runDiscount({ slug: SLUG, percent: "25" });
  // Only two requests: resolve the id, then write. No verify/re-read step —
  // the PATCH response already carries the resulting price.
  expect(sent).toHaveLength(2);
  expect(result).toEqual({
    product_id: 111222333,
    undiscounted_price: "100.00",
    discounted_price: "75.00",
    discount_percentage: 25,
    discount_type: "PERCENTAGE",
  });
});

test("dry run plans the id lookup and the write without sending", async () => {
  const steps = await plan("discount", { slug: SLUG, percent: "20" });
  expect(steps.map((s) => s.step)).toEqual(["current", "setDiscount"]);
  expect(steps[0]!.method).toBe("GET");
  expect(steps[1]!.method).toBe("PATCH");
  // product_id depends on step "current"'s real response, which dry-run never
  // fetches (a stub stands in — see workflow.ts's stepStub); only the
  // directly-templated percentage is real at plan time.
  const body = steps[1]!.body as unknown as [{ discount_percentage: number }];
  expect(body[0]!.discount_percentage).toBe(20);
});

test("discount's percent enum covers 0 and every 5% step up to 95, nothing else", () => {
  const args = depopSpec().byCommand("discount")!.operation["x-depop-args"] ?? [];
  const percent = args.find((a) => a.name === "percent")!;
  expect(percent.required).toBe(true);
  expect(percent.enum).toEqual(
    Array.from({ length: 20 }, (_, i) => String(i * 5)), // 0, 5, 10, ..., 95
  );
});

// -- update x discount interaction ------------------------------------------

/**
 * The full edit-listing read shape `update` needs to build its replacing PUT
 * (mirrors depop-listing.test.ts's CURRENT_LISTING), for a listing that is
 * ALSO currently on sale (is_reduced: true, discounted_price present) — the
 * scenario the spec/README warning used to flag as unverified.
 */
const DISCOUNTED_LISTING = {
  id: 111222333,
  brand_id: 50,
  brand_name: "Example Brand",
  description: "Example listing text\n\n- a bullet\n#example #sneakers",
  pictures: [
    { id: 901, url: "https://media-photos.example/901/P0.jpg" },
    { id: 902, url: "https://media-photos.example/902/P0.jpg" },
  ],
  country: "US",
  pricing: {
    currency: "USD",
    is_reduced: true,
    original_price: { total_price: "100.00" },
    discounted_price: { total_price: "75.00" },
  },
  national_shipping_cost: "3.99",
  slug: "seller-example-item-abcd",
  variant_set_id: 46,
  condition: "used_excellent",
  colour: ["white", "grey"],
  style: ["streetwear", "sportswear"],
  age: ["modern"],
  source: ["preloved"],
  brand: "example-brand",
  gender: "female",
  is_kids: false,
  product_type: "trainers",
  variants: { "3": 1 },
  shipping_methods: [
    { shipping_provider_id: "USPS", ship_from_address_id: 26518315, parcel_size_id: "medium", payer: "buyer" },
  ],
};

test("an update never carries discount fields — the discount survives an unrelated edit", async () => {
  // The load-bearing regression: update's replacing PUT has no discount field
  // to begin with (discount lives on a separate resource keyed by product id),
  // so an edit made through `update` cannot silently drop a listing's sale.
  // Runs the ACTUAL update workflow (not just its declared flag names) against
  // a listing that IS on sale, and inspects the real PUT body — the wire
  // bytes, not the CLI's arg list.
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
        const isWrite = req.method === "PUT";
        sent.push({
          method: req.method,
          url: req.url,
          body: typeof req.body === "string" ? JSON.parse(req.body) : req.body,
        });
        return {
          status: isWrite ? 204 : 200,
          headers: {},
          text: async () => (isWrite ? "" : JSON.stringify(DISCOUNTED_LISTING)),
        };
      },
    }),
  });

  await runner.run(spec.byCommand("update")!, {
    slug: SLUG,
    description: "Retitled — unrelated to the sale",
    "variant-set": "",
    variant: "",
    gender: "",
  });

  const put = sent.find((s) => s.method === "PUT")!;
  const body = put.body as Record<string, unknown>;
  for (const forbidden of ["discount", "discount_percentage", "discounted_price", "is_reduced"]) {
    expect(body[forbidden]).toBeUndefined();
  }
  expect(JSON.stringify(body).toLowerCase()).not.toContain("discount");
});

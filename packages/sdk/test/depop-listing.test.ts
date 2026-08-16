/**
 * The Depop listing write flows (`list` and `update`), run against the real
 * provider spec.
 *
 * The update half is pinned to a capture of an actual edit made through
 * depop.com's seller form on 2026-08-13: a PUT to the by-slug path that
 * REPLACES the listing. That is why these tests care so much about what the
 * body carries rather than what it omits. A replacing write that forgets a
 * field clears it, and forgetting picture_ids would drop every photo, so the
 * flow reads the listing first and merges changes over it. The fixture below is
 * the captured response shape with neutral values.
 */
import { readFileSync, writeFileSync } from "node:fs";
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

/**
 * The edit-listing read, shaped exactly as Depop returns it (field names and
 * types from the capture, values neutral). Note what the read does NOT have:
 * no geo coordinates, and its own names for things the write spells
 * differently (variant_set_id, parcel_size_id, pictures).
 */
const CURRENT_LISTING = {
  id: 111222333,
  user_id: 44455566,
  brand_id: 50,
  brand_name: "Example Brand",
  active_status: "active",
  status: "STATUS_ONSALE",
  category_name: "Sneakers",
  categories: ["Womenswear", "Shoes", "Sneakers"],
  description: "Example listing text\n\n- a bullet\n#example #sneakers",
  updated_at: "2026-08-13T00:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
  pictures: [
    { id: 901, url: "https://media-photos.example/901/P0.jpg" },
    { id: 902, url: "https://media-photos.example/902/P0.jpg" },
  ],
  location: "United States",
  country: "US",
  pricing: {
    currency: "USD",
    currency_name: "USD",
    is_reduced: false,
    original_price: { total_price: "100.00" },
  },
  national_shipping_cost: "3.99",
  slug: "seller-example-item-abcd",
  variant_set_id: 46,
  is_boosted: false,
  condition: "used_excellent",
  colour: ["white", "grey"],
  style: ["streetwear", "sportswear"],
  age: ["modern"],
  source: ["preloved"],
  brand: "example-brand",
  gender: "female",
  is_kids: false,
  group: "footwear",
  product_type: "trainers",
  variants: { "3": 1 },
  shipping_methods: [
    { shipping_provider_id: "USPS", ship_from_address_id: 26518315, parcel_size_id: "medium", payer: "buyer" },
  ],
};

/** What the country-derived location fields must come out as, for US. */
const US_GEO = (loadSpecFile("reference/country_geo.json") as Record<string, Record<string, unknown>>)
  .US as { address: string; geoLat: number; geoLng: number };

/**
 * Dry-run a workflow command and return its planned requests. `args` is what
 * the CLI + connector hand the runner: the flags the user typed, plus the
 * derived ones (variant-set / variant / gender), which the file-backed resolver
 * sets to "" when their inputs weren't passed.
 */
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
 * Run `update` for real against a mock Depop: the read returns CURRENT_LISTING,
 * the PUT answers 204 like the live endpoint. Returns every request the flow
 * made, so a test can assert the exact bytes that would hit the wire.
 */
async function runUpdate(args: Record<string, unknown>): Promise<
  { method: string; url: string; body?: unknown }[]
> {
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
        sent.push({
          method: req.method,
          url: req.url,
          body: typeof req.body === "string" ? JSON.parse(req.body) : req.body,
        });
        // The live PUT answers 204 with an empty body.
        const isWrite = req.method === "PUT";
        return {
          status: isWrite ? 204 : 200,
          headers: {},
          text: async () => (isWrite ? "" : JSON.stringify(CURRENT_LISTING)),
        };
      },
    }),
  });
  await runner.run(spec.byCommand("update")!, args);
  return sent;
}

/** The derived flags as they arrive when the user passed no size/department. */
const NO_DERIVED = { "variant-set": "", variant: "", gender: "" };
const SLUG = "seller-example-item-abcd";

// -- update -----------------------------------------------------------------

test("update reads the listing, replaces it by slug, then reads it back", async () => {
  const sent = await runUpdate({ slug: SLUG, price: "110", ...NO_DERIVED });
  expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
    `GET https://webapi.depop.com/presentation/api/v1/products/by-slug/${SLUG}/edit-listing/`,
    `PUT https://webapi.depop.com/presentation/api/v1/products/by-slug/${SLUG}/`,
    `GET https://webapi.depop.com/presentation/api/v1/products/by-slug/${SLUG}/edit-listing/`,
  ]);
});

test("a price edit sends the whole listing back with only the price changed", async () => {
  const sent = await runUpdate({ slug: SLUG, price: "110", ...NO_DERIVED });
  const put = sent.find((s) => s.method === "PUT")!;
  // This is the captured payload shape, field for field.
  expect(put.body).toEqual({
    description: CURRENT_LISTING.description,
    brand: "example-brand",
    condition: "used_excellent",
    colour: ["white", "grey"],
    style: ["streetwear", "sportswear"],
    age: ["modern"],
    source: ["preloved"],
    gender: "female",
    is_kids: false,
    product_type: "trainers",
    variant_set: 46, // read calls this variant_set_id
    variants: { "3": 1 },
    picture_ids: [901, 902], // read gives objects; the write wants bare ids
    price_amount: "110", // the one thing being changed
    price_currency: "USD",
    national_shipping_cost: "3.99",
    country: "US",
    address: US_GEO.address, // absent from the read, derived from the country
    geo_position_lat: US_GEO.geoLat,
    geo_position_lng: US_GEO.geoLng,
    attributes: {},
    shipping_methods: [
      {
        payer: "buyer",
        parcel_size: "medium", // read calls this parcel_size_id
        shipping_provider_id: "USPS",
        ship_from_address_id: 26518315,
      },
    ],
  });
});

test("photos survive an edit that has nothing to do with photos", async () => {
  // The endpoint replaces the listing, so dropping picture_ids would delete
  // every photo. This is the single most destructive thing this flow could do.
  const sent = await runUpdate({ slug: SLUG, description: "new text", ...NO_DERIVED });
  const put = sent.find((s) => s.method === "PUT")!;
  expect((put.body as { picture_ids: number[] }).picture_ids).toEqual([901, 902]);
});

test("an edit never carries boost or the create-time identifiers", async () => {
  const sent = await runUpdate({ slug: SLUG, price: "110", ...NO_DERIVED });
  const put = sent.find((s) => s.method === "PUT")!;
  const body = put.body as Record<string, unknown>;
  for (const forbidden of ["boost", "is_boosted", "listing_lifecycle_id", "persistent_id", "id", "slug"]) {
    expect(body[forbidden]).toBeUndefined();
  }
  expect(JSON.stringify(body)).not.toContain("boost");
});

test("a size edit rewrites the variants map whole", async () => {
  const sent = await runUpdate({
    slug: SLUG,
    department: "womenswear",
    type: "trainers",
    size: "6",
    quantity: "2",
    "variant-set": "46",
    variant: "4",
    gender: "female",
  });
  const body = sent.find((s) => s.method === "PUT")!.body as Record<string, unknown>;
  expect(body.variants).toEqual({ "4": 2 });
  expect(body.variant_set).toBe(46);
  expect(body.product_type).toBe("trainers");
});

test("a ship-from change keeps the rest of the shipping block", async () => {
  const sent = await runUpdate({ slug: SLUG, "address-id": "99887766", ...NO_DERIVED });
  const body = sent.find((s) => s.method === "PUT")!.body as Record<string, unknown>;
  expect(body.shipping_methods).toEqual([
    {
      payer: "buyer",
      parcel_size: "medium",
      shipping_provider_id: "USPS",
      ship_from_address_id: 99887766,
    },
  ]);
  // The cost Depop derived from that parcel size rides along untouched.
  expect(body.national_shipping_cost).toBe("3.99");
});

test("an update with nothing to change is refused before anything is written", async () => {
  // A replacing PUT of the listing over itself is not a harmless no-op.
  await expect(runUpdate({ slug: SLUG, ...NO_DERIVED })).rejects.toThrow(/nothing to send/);
  const err = await runUpdate({ slug: SLUG, ...NO_DERIVED }).catch((e: unknown) => e);
  expect((err as { exitCode?: number }).exitCode).toBe(2);
});

test("dry run plans the read, the write and the read-back without sending", async () => {
  const steps = await plan("update", { slug: SLUG, price: "110", ...NO_DERIVED });
  expect(steps.map((s) => s.step)).toEqual(["current", "updateListing", "verify"]);
  expect(steps[1]!.method).toBe("PUT");
  expect((steps[1]!.body as { price_amount: string }).price_amount).toBe("110");
});

test("every requires entry names a flag the command actually declares", async () => {
  // A stale name here is a trap: the flag it sits on becomes impossible to use,
  // because its partner can never be supplied. Renaming a flag has to update it.
  for (const command of ["update", "list"]) {
    const args = depopSpec().byCommand(command)!.operation["x-depop-args"] ?? [];
    const declared = new Set(args.map((a) => a.name));
    for (const arg of args) {
      for (const partner of arg.requires ?? []) {
        expect({ command, arg: arg.name, partner, declared: declared.has(partner) }).toEqual({
          command,
          arg: arg.name,
          partner,
          declared: true,
        });
      }
    }
  }
});

// -- create -----------------------------------------------------------------

/** A stand-in photo: the s3Put step reads the file's bytes even in a dry run. */
function tempPhoto(): string {
  const path = `/tmp/depop-depop-test-${process.pid}.jpg`;
  writeFileSync(path, new Uint8Array([0xff, 0xd8, 0xff]));
  return path;
}

test("the create body pins boost off", async () => {
  // The hard rule: depop never enables a boost on a listing. Boost is a fixed
  // `inactive` in the spec, so this fails the moment anyone flips it or wires it
  // to a flag.
  const steps = await plan("list", {
    photo: [tempPhoto()],
    brand: "polo-ralph-lauren",
    department: "menswear",
    type: "tshirts",
    size: "M",
    condition: "used_good",
    colour: ["navy"],
    price: "25",
    description: "Vintage Polo tee #ralphlauren",
    address: "San Francisco, United States",
    "address-id": "42475963",
    lat: "37.779026",
    lng: "-122.419906",
    "variant-set": "54",
    variant: "4",
    gender: "male",
  });

  const create = steps.find((s) => s.step === "createListing")!;
  expect(create.body.boost).toEqual({ status: "inactive" });
  // Quoted, so "inactive" doesn't match: no field anywhere is the string "active".
  expect(JSON.stringify(create.body)).not.toContain('"active"');
});

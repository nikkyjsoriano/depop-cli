/**
 * The Depop `update` workflow, planned against the real provider spec.
 *
 * The point of an update command is what it does NOT send: a price edit must
 * not carry a size, a shipping block, photos, or a boost. These run the actual
 * providers/depop/openapi.yaml through a dry run, so drift in that file shows
 * up here rather than on Nikky's live listings.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { parseOpenApi, type OpenApiSpec } from "@mastro/core";
import { WorkflowRunner } from "../src/index.ts";

const SPEC_PATH = join(import.meta.dir, "../../../providers/depop/openapi.yaml");

function depopSpec(): OpenApiSpec {
  return parseOpenApi(readFileSync(SPEC_PATH, "utf8"));
}

/**
 * Plan the update workflow. `args` is what the CLI + connector hand the runner:
 * flags the user typed, plus the derived flags (variant-set / variant / gender),
 * which the file-backed resolver sets to "" when their inputs weren't passed.
 */
async function planUpdate(args: Record<string, unknown>): Promise<{ method: string; url: string; body: Record<string, unknown> }> {
  const spec = depopSpec();
  const runner = new WorkflowRunner({
    spec,
    authHeaders: () => ({ authorization: "Bearer tok" }),
    baseContext: () => ({ auth: { access_token: "tok" }, uuid: () => "fixed-uuid" }),
    apiTransport: async () => {
      throw new Error("dry run must not send");
    },
    dryRun: true,
  });
  const op = spec.byCommand("update")!;
  const result = (await runner.run(op, args)) as {
    planned_requests: { step: string; method: string; url: string; body: Record<string, unknown> }[];
  };
  const req = result.planned_requests.find((r) => r.step === "updateListing")!;
  return { method: req.method, url: req.url, body: req.body };
}

/** The derived flags as they arrive when the user passed no size/department. */
const NO_DERIVED = { "variant-set": "", variant: "", gender: "" };

test("update is a command and hits the listing endpoint on the webapi host", async () => {
  const { method, url } = await planUpdate({ id: "123456789", price: "20", ...NO_DERIVED });
  expect(method).toBe("PATCH");
  expect(url).toBe("https://webapi.depop.com/presentation/api/v1/listing/products/123456789/");
});

test("a price edit sends only the price", async () => {
  const { body } = await planUpdate({ id: "123456789", price: "20", ...NO_DERIVED });
  expect(body).toEqual({ price_amount: "20" });
});

test("unresolved derived flags are dropped, not sent as empty strings", async () => {
  // variant-set/variant/gender resolve to "" whenever --department/--type/--size
  // weren't passed. Sending `variant_set: ""` would be a wire lie.
  const { body } = await planUpdate({ id: "1", description: "new text #vintage", ...NO_DERIVED });
  expect(body).toEqual({ description: "new text #vintage" });
});

test("a size edit sends the variants map whole, never an empty one", async () => {
  const { body } = await planUpdate({
    id: "1",
    department: "menswear",
    type: "tshirts",
    size: "M",
    "variant-set": "54",
    variant: "4",
    gender: "male",
  });
  expect(body).toEqual({
    gender: "male",
    product_type: "tshirts",
    variant_set: 54, // numeric on the wire, like create
    variants: { "4": 1 },
  });
});

test("shipping is sent as a block, and only when --parcel-size is passed", async () => {
  const withShipping = await planUpdate({
    id: "1",
    "parcel-size": "large",
    "address-id": "42475963",
    ...NO_DERIVED,
  });
  expect(withShipping.body.shipping_methods).toEqual([
    { payer: "buyer", parcel_size: "large", shipping_provider_id: "USPS", ship_from_address_id: 42475963 },
  ]);

  // --address-id alone doesn't half-build the block (that would overwrite the
  // parcel size on the listing); it needs --parcel-size to go out.
  const addressOnly = await planUpdate({ id: "1", "address-id": "42475963", ...NO_DERIVED });
  expect(addressOnly.body.shipping_methods).toBeUndefined();
});

test("an update never carries photos, boost, or the create-time identifiers", async () => {
  // Everything the flags can set, at once — the excluded fields must still be
  // absent. Boost in particular is never enabled by mastro.
  const { body } = await planUpdate({
    id: "1",
    price: "20",
    currency: "USD",
    description: "text",
    brand: "polo-ralph-lauren",
    condition: "used_good",
    colour: ["navy"],
    department: "menswear",
    type: "tshirts",
    size: "M",
    quantity: "2",
    age: ["y2k"],
    style: ["streetwear"],
    source: ["preloved"],
    address: "San Francisco, United States",
    lat: "37.779026",
    lng: "-122.419906",
    "address-id": "42475963",
    "parcel-size": "medium",
    "variant-set": "54",
    variant: "4",
    gender: "male",
  });
  for (const forbidden of ["picture_ids", "boost", "listing_lifecycle_id", "persistent_id"]) {
    expect(body[forbidden]).toBeUndefined();
  }
  expect(JSON.stringify(body)).not.toContain("boost");
});

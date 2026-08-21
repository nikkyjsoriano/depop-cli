import { expect, test } from "bun:test";

import { renderDeep, renderTemplate, MissingTemplateValue } from "../src/index.ts";

test("plain placeholder preserves the resolved value's type", () => {
  expect(renderTemplate("${a}", { a: 42 })).toBe(42);
  expect(renderTemplate("${a}", { a: "x" })).toBe("x");
});

test("num: casts a numeric string to a JS number", () => {
  expect(renderTemplate("${num:a}", { a: "42" })).toBe(42);
  expect(renderTemplate("${num:a}", { a: "3.5" })).toBe(3.5);
});

test("num: leaves a non-numeric value as-is", () => {
  expect(renderTemplate("${num:a}", { a: "abc" })).toBe("abc");
});

test("a missing value throws in strict mode", () => {
  expect(() => renderTemplate("${nope}", {})).toThrow(MissingTemplateValue);
});

// -- optional (`${?path}`) and guard (`${path:+literal}`) -------------------
// Together these express a PARTIAL body: only the fields the user passed.

test("${?path} resolves like a normal placeholder when the value is there", () => {
  expect(renderTemplate("${?a}", { a: 42 })).toBe(42);
  expect(renderTemplate("${?num:a}", { a: "3.5" })).toBe(3.5);
});

test("${?path} yields undefined instead of throwing in strict mode", () => {
  expect(renderTemplate("${?nope}", {})).toBeUndefined();
  // Empty counts as missing: a derived flag that resolved to "" isn't a value.
  expect(renderTemplate("${?a}", { a: "" })).toBeUndefined();
  expect(renderTemplate("${?a}", { a: null })).toBeUndefined();
});

test("renderDeep drops the entries whose optional value is missing", () => {
  const body = { price: "${?args.price}", brand: "${?args.brand}", fixed: 1 };
  expect(renderDeep(body, { args: { price: "20" } })).toEqual({ price: "20", fixed: 1 });
});

test("renderDeep drops missing optional array elements rather than nulling them", () => {
  expect(renderDeep(["${?args.a}", "${?args.b}"], { args: { b: "y" } })).toEqual(["y"]);
});

test("${?path} inside a mixed string interpolates to nothing instead of throwing", () => {
  expect(renderTemplate("size-${?a}", {})).toBe("size-");
  expect(renderTemplate("size-${?a}", { a: "M" })).toBe("size-M");
});

test("${path:+literal} renders the literal only when the path is set", () => {
  expect(renderTemplate("${a:+shipping_methods}", { a: "medium" })).toBe("shipping_methods");
  expect(renderTemplate("${a:+shipping_methods}", { a: "" })).toBe("");
  expect(renderTemplate("${a:+shipping_methods}", {})).toBe("");
  // The guard binds before `|`, so a literal may contain a pipe.
  expect(renderTemplate("${a:+one|two}", { a: "set" })).toBe("one|two");
});

// -- [field=value] array-match subscript -------------------------------
// Cross-references two independently fetched resources by a shared id inside
// a workflow, e.g. resolving a listing's variant_id from the `offers`
// summary by matching its product_id — see `offer-list` in openapi.yaml.

test("[field=value] finds the array element matching field, then continues the path", () => {
  const ctx = {
    steps: {
      mine: { objects: [
        { product_id: 1, variant_id: 10 },
        { product_id: 2, variant_id: 20 },
      ] },
      current: { id: 2 },
    },
  };
  expect(renderTemplate("${steps.mine.objects[product_id=${steps.current.id}].variant_id}", ctx)).toBe(20);
});

test("[field=value] with no match resolves to undefined", () => {
  const ctx = { objects: [{ product_id: 1, variant_id: 10 }] };
  expect(renderTemplate("${?objects[product_id=999].variant_id}", ctx)).toBeUndefined();
});

test("[field=value] passes a non-array value through unfiltered", () => {
  // Mirrors a dry-run step stub, which is an object (not an array) until the
  // step actually runs — the filter is skipped so a downstream path segment
  // still resolves instead of throwing.
  const ctx = { steps: { mine: { objects: { variant_id: "STUB" } } } };
  expect(renderTemplate("${steps.mine.objects[product_id=1].variant_id}", ctx)).toBe("STUB");
});

test("a guarded key drops its whole group, and skips rendering the group's body", () => {
  const body = {
    "${args.size:+variants}": { "${args.size}": 1 },
    price: "${args.price}",
  };
  // Guard passes: the group is built.
  expect(renderDeep(body, { args: { size: "4", price: "20" } })).toEqual({
    variants: { "4": 1 },
    price: "20",
  });
  // Guard fails: the group vanishes — and its inner `${args.size}` is never
  // rendered, so strict mode doesn't trip on a flag that only exists inside it.
  expect(renderDeep(body, { args: { price: "20" } }, { strict: true })).toEqual({ price: "20" });
});

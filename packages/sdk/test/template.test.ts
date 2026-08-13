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

test("unquote: strips one layer of surrounding double-quotes", () => {
  // LinkedIn stores JSESSIONID as `"ajax:123"`; csrf-token wants `ajax:123`.
  expect(renderTemplate("${unquote:auth.jsessionid}", { auth: { jsessionid: '"ajax:123"' } })).toBe(
    "ajax:123",
  );
});

test("unquote: passes through a value that has no surrounding quotes", () => {
  expect(renderTemplate("${unquote:a}", { a: "ajax:plain" })).toBe("ajax:plain");
});

test("unquote: only strips a matched leading+trailing pair, not inner quotes", () => {
  expect(renderTemplate("${unquote:a}", { a: 'a"b"c' })).toBe('a"b"c');
});

test("unquote: leaves a non-string value untouched", () => {
  expect(renderTemplate("${unquote:a}", { a: 7 })).toBe(7);
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

test("${path:+literal} renders the literal only when the path is set", () => {
  expect(renderTemplate("${a:+shipping_methods}", { a: "medium" })).toBe("shipping_methods");
  expect(renderTemplate("${a:+shipping_methods}", { a: "" })).toBe("");
  expect(renderTemplate("${a:+shipping_methods}", {})).toBe("");
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

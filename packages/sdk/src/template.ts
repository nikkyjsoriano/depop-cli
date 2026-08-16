/**
 * Template resolution for x-depop-* strings.
 *
 * Profiles use `${scope.path}` placeholders that resolve against a context,
 * typically `{ auth: <credential fields>, args: <cli args> }`. A string that is
 * exactly one placeholder preserves the resolved value's type (so a body field
 * can be a number/array/object); mixed strings interpolate to text.
 *
 * Two markers exist for bodies that must be *partial* — an update that only
 * carries the fields the user actually passed:
 *   `${?path}`        optional: missing resolves to undefined and the body entry
 *                     holding it is dropped (see renderDeep).
 *   `${path:+literal}` guard: the literal when `path` is set, else "" — on a key,
 *                     that drops the whole entry (an all-or-nothing group).
 */

export type TemplateContext = Record<string, unknown>;

// A string that is exactly one placeholder. The body may contain a literal `{}`
// so the documented empty-object fallback (`${a.b|{}}`) is actually reachable;
// any other brace means this isn't a lone placeholder (e.g. "${x}${y}") and the
// mixed-string path handles it.
const WHOLE = /^\$\{((?:[^{}]|\{\})+)\}$/;
const PART = /\$\{([^}]+)\}/g;
/** An innermost placeholder: `${...}` whose body has no nested `${`. */
const INNER = /\$\{([^${}]+)\}/;

export class MissingTemplateValue extends Error {
  constructor(public readonly expr: string) {
    super(`template value "${expr}" resolved to undefined`);
    this.name = "MissingTemplateValue";
  }
}

/** Resolve a single template string. Preserves type for whole-placeholder strings. */
export function renderTemplate(
  template: string,
  ctx: TemplateContext,
  { strict = true }: { strict?: boolean } = {},
): unknown {
  template = resolveNested(template, ctx, strict);

  const whole = template.match(WHOLE);
  if (whole) {
    // A leading `?` marks the placeholder OPTIONAL: a missing value resolves to
    // `undefined` instead of throwing under strict mode, and `renderDeep` drops
    // the body entry that held it. This is what makes a *partial* update
    // expressible as data — `price_amount: "${?args.price}"` is simply absent
    // from the body when the user didn't pass --price, so the field keeps its
    // current value. Empty ("" / null) counts as missing: a derived flag that
    // resolved to nothing must not be sent as an empty string.
    const { expr: optExpr, optional } = splitOptional(whole[1]!.trim());
    let expr = optExpr;
    // A leading `num:` casts to a JS number, so a body field serializes as a
    // JSON number rather than a string — Depop wants numeric lat/lng, address
    // id and variant_set.
    let cast: "number" | undefined;
    if (expr.startsWith("num:")) {
      cast = "number";
      expr = expr.slice(4).trim();
    }
    const value = lookup(expr, ctx);
    if (optional && isAbsent(value)) return undefined;
    if (value === undefined && strict) throw new MissingTemplateValue(expr);
    if (cast === "number" && value != null && value !== "") {
      const n = Number(value);
      if (!Number.isNaN(n)) return n;
    }
    return value;
  }
  return template.replace(PART, (_, raw: string) => {
    const { expr, optional } = splitOptional(raw.trim());
    const value = lookup(expr, ctx);
    if (value === undefined && strict && !optional) throw new MissingTemplateValue(expr);
    return value == null ? "" : String(value);
  });
}

/** Render every string in an object tree (used for request bodies). */
export function renderDeep(value: unknown, ctx: TemplateContext, opts?: { strict?: boolean }): unknown {
  if (typeof value === "string") return renderTemplate(value, ctx, opts);
  if (Array.isArray(value)) {
    // An optional element that resolved to nothing is dropped rather than
    // serialized as `null`.
    return value.map((v) => renderDeep(v, ctx, opts)).filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    // Render both keys and values so a body can have a dynamic key, e.g.
    // `{ "${args.variant}": 1 }` → `{ "4": 1 }` (Depop's `variants` map). An
    // entry whose key renders empty (e.g. a one-size item with no variant) is
    // dropped, so `{ "${args.variant}": 1 }` becomes `{}` rather than `{ "": 1 }`.
    // A dropped key short-circuits its value: the value of an entry that isn't
    // being sent is never rendered, so a guarded group (`"${args.x:+group}"`)
    // can reference flags that only exist when the guard passed.
    const out: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = renderTemplateString(rawKey, ctx, opts);
      if (key === "") continue;
      const rendered = renderDeep(rawValue, ctx, opts);
      // An optional placeholder (`${?args.price}`) that resolved to nothing
      // drops its field, which is how a partial update leaves it untouched.
      if (rendered === undefined) continue;
      out[key] = rendered;
    }
    return out;
  }
  return value;
}

/**
 * Render a template that is expected to produce a string (a URL path, a header
 * value). Coerces the resolved value to a string so call sites don't need a
 * cast; throws via `renderTemplate` if a required placeholder is missing.
 */
export function renderTemplateString(
  template: string,
  ctx: TemplateContext,
  opts?: { strict?: boolean },
): string {
  const value = renderTemplate(template, ctx, opts);
  return value == null ? "" : String(value);
}

/** Render a map of string templates to strings (headers, query params). */
export function renderStringMap(
  map: Record<string, string>,
  ctx: TemplateContext,
  opts?: { strict?: boolean },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const rendered = renderTemplate(v, ctx, opts);
    if (rendered != null) out[k] = String(rendered);
  }
  return out;
}

/**
 * Resolve nested placeholders inside-out, e.g. `${steps.slots.${index}}` with
 * index=0 → `${steps.slots.0}`. Repeatedly substitutes the innermost
 * placeholder (one with no `${` in its body) until only top-level placeholders
 * remain, which the caller then resolves normally. A string with no nesting is
 * returned unchanged after one cheap scan.
 */
function resolveNested(template: string, ctx: TemplateContext, strict: boolean): string {
  // Only the body of an *outer* placeholder can contain a nested `${`. If no
  // placeholder body contains `${`, there's nothing to pre-resolve.
  while (/\$\{[^}]*\$\{/.test(template)) {
    const before = template;
    template = template.replace(INNER, (_, raw: string) => {
      const { expr, optional } = splitOptional(raw.trim());
      const value = lookup(expr, ctx);
      if (value === undefined && strict && !optional) throw new MissingTemplateValue(expr);
      return value == null ? "" : String(value);
    });
    if (template === before) break; // no progress — avoid an infinite loop
  }
  return template;
}

/** Split a leading `?` (the optional marker) off a placeholder body. */
function splitOptional(expr: string): { expr: string; optional: boolean } {
  return expr.startsWith("?") ? { expr: expr.slice(1).trim(), optional: true } : { expr, optional: false };
}

/** For an optional placeholder, undefined / null / "" all mean "not supplied". */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function lookup(expr: string, ctx: TemplateContext): unknown {
  // `${path:+literal}` — the literal when `path` resolves to something, else "".
  // (Same idea as the shell's `${VAR:+word}`, mirroring the `|` fallback above,
  // which is `${VAR:-word}`.) Its use is on a body KEY: an entry whose key
  // renders empty is dropped, so `"${args.parcel-size:+shipping_methods}"`
  // includes the whole shipping block only when --parcel-size was passed —
  // sending a half-built group would overwrite what's on the listing today.
  // Binds before `|`, so the literal can itself contain a pipe.
  const guard = expr.indexOf(":+");
  if (guard !== -1) {
    return isAbsent(lookup(expr.slice(0, guard), ctx)) ? "" : expr.slice(guard + 2);
  }

  // `${path|fallback}` — use the literal fallback when the path is empty/missing.
  const pipe = expr.indexOf("|");
  const path = pipe === -1 ? expr : expr.slice(0, pipe);
  const fallback = pipe === -1 ? undefined : expr.slice(pipe + 1);

  const value = path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, ctx);

  // A leaf that resolves to a zero-arg function is a generator (e.g. `${uuid}`,
  // `${now}`) — call it so each use produces a fresh value.
  const resolved = typeof value === "function" ? (value as () => unknown)() : value;
  if ((resolved === undefined || resolved === "") && fallback !== undefined) {
    // `[]` / `{}` fallbacks yield real empty JSON containers (so an omitted
    // repeatable flag like --age becomes `[]`, not the literal string "[]").
    if (fallback === "[]") return [];
    if (fallback === "{}") return {};
    return fallback;
  }
  return resolved;
}

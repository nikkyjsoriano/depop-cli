/**
 * Tiny TTL'd JSON cache for fetched taxonomy data (sizes, brands, categories).
 * One file per key under ~/.depop/cache/<key>.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { depopHome, unixNow } from "@depop/core";

interface CacheEnvelope<T> {
  stored_at: number;
  ttl_seconds: number;
  value: T;
}

export class JsonCache {
  private readonly dir: string;

  constructor(root: string = depopHome()) {
    this.dir = join(root, "cache");
  }

  /** Return the cached value if present and not expired, else undefined. */
  get<T>(key: string): T | undefined {
    const path = this.pathFor(key);
    if (!existsSync(path)) return undefined;
    try {
      const env = JSON.parse(readFileSync(path, "utf8")) as CacheEnvelope<T>;
      if (env.stored_at + env.ttl_seconds <= unixNow()) return undefined;
      return env.value;
    } catch {
      return undefined;
    }
  }

  set<T>(key: string, value: T, ttlSeconds: number): void {
    mkdirSync(this.dir, { recursive: true });
    const env: CacheEnvelope<T> = { stored_at: unixNow(), ttl_seconds: ttlSeconds, value };
    writeFileSync(this.pathFor(key), JSON.stringify(env));
  }

  private pathFor(key: string): string {
    // keys are operationIds — already filesystem-safe, but normalize spaces.
    return join(this.dir, `${key.replace(/[^\w.-]+/g, "_")}.json`);
  }
}

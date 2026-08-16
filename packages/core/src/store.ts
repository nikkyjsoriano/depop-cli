/**
 * Credential store — where the validated capture lives on disk.
 *
 * `CredentialStore` is the interface; `FileStore` is the default backend
 * (~/.depop/credential.json, mode 0600). Keychain / secret-manager backends
 * can implement the same interface later.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { PersistedCredential } from "./types.ts";

export interface CredentialStore {
  get(): PersistedCredential | undefined;
  set(credential: PersistedCredential): void;
  delete(): boolean;
}

/** Default root: ~/.depop (override with DEPOP_HOME). */
export function depopHome(): string {
  return process.env.DEPOP_HOME ?? join(homedir(), ".depop");
}

export class FileStore implements CredentialStore {
  private readonly path: string;

  constructor(root: string = depopHome()) {
    this.path = join(root, "credential.json");
  }

  get(): PersistedCredential | undefined {
    if (!existsSync(this.path)) return undefined;
    return JSON.parse(readFileSync(this.path, "utf8")) as PersistedCredential;
  }

  set(credential: PersistedCredential): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Write then tighten perms — the secret never touches a world-readable file.
    writeFileSync(this.path, JSON.stringify(credential, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  delete(): boolean {
    if (!existsSync(this.path)) return false;
    rmSync(this.path);
    return true;
  }
}

/** True if the credential has an expiry in the past. */
export function isExpired(credential: PersistedCredential, nowSeconds = unixNow()): boolean {
  return credential.expires_at !== undefined && credential.expires_at <= nowSeconds;
}

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

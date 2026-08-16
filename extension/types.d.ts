/**
 * Shared types for the depop capture extension.
 *
 * These mirror the runtime contracts in `@depop/core` (AuthManifest,
 * CaptureBundle). They're declared here as ambient types so the plain-JS
 * extension files can be `checkJs`-verified without a bundler or imports.
 */

// -- manifest (subset the extension actually reads) -------------------------

interface DepopCookieRule {
  url: string;
  include_names_matching: string[];
  save_as?: string;
}

interface DepopHeaderRule {
  source: "request" | "response";
  url_matches: string;
  is_regex?: boolean;
  include_names: string[];
  save_as?: string;
}

interface DepopPageEventRule {
  source: "fetch-response" | "xhr-response";
  url_matches: string;
  is_regex?: boolean;
  body_json_path?: string;
  save_as: string;
}

interface DepopStorageRule {
  area: "local" | "session";
  keys?: string[];
  save_as?: string;
}

interface DepopCaptureSpec {
  cookies?: DepopCookieRule[];
  headers?: DepopHeaderRule[];
  page_events?: DepopPageEventRule[];
  storage?: DepopStorageRule[];
}

type DepopCompletionRule =
  | { all: DepopCompletionRule[] }
  | { any: DepopCompletionRule[] }
  | { not: DepopCompletionRule }
  | { field_present: string }
  | { cookie_present: string }
  | { cookie_name_prefix_present: string }
  | { header_seen: string }
  | { storage_key_present: string }
  | { authenticated_response_seen: string };

interface DepopSerializationSpec {
  output_schema: string;
  fields: Record<string, string>;
}

interface DepopAuthManifest {
  schema_version: string;
  provider_id: string;
  display_name: string;
  launch: { url: string; open_tab?: boolean; expected_origins: string[]; timeout_seconds: number };
  permissions: { host_permissions: string[]; injects_page_bridge?: boolean };
  capture: DepopCaptureSpec;
  completion: DepopCompletionRule;
  serialization: DepopSerializationSpec;
  security: { redact_fields: string[]; allowed_postback_origin: string };
}

// -- session + state --------------------------------------------------------

interface DepopSessionPayload {
  sessionId: string;
  providerId: string;
  displayName: string;
  launchUrl: string;
  manifest: DepopAuthManifest;
}

interface DepopCookie {
  value: string;
  domain: string;
}

/** Accumulated observations during a capture session. */
interface DepopState {
  cookies: Record<string, DepopCookie>;
  headers: Record<string, string>;
  storage: { local: Record<string, string>; session: Record<string, string> };
  /** Internal: URLs of successful authenticated responses. */
  __authedResponses?: string[];
  /** Extracted page-event values land here by their `save_as` path. */
  [key: string]: unknown;
}

interface DepopSession {
  sessionId: string;
  providerId: string;
  receiverBaseUrl: string;
  manifest: DepopAuthManifest;
  launchUrl: string;
  appTabId: number | undefined;
  bootstrapTabId: number | undefined;
  state: DepopState;
  seenHeaders: Set<string>;
  submitted: boolean;
}

// -- worker messages (content scripts → background) -------------------------

type DepopMessage =
  | { action: "startAuthSession"; session: DepopSessionPayload; receiverBaseUrl: string }
  | { action: "isSessionTab" }
  | { action: "getStatus" }
  | { action: "pageReady"; url: string }
  | { action: "bridgeEvent"; detail: DepopBridgeEvent };

// -- browser proxy (run requests in an authenticated tab) -------------------

interface ProxyRequest {
  id: string;
  origin: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

// -- page-bridge event payloads ---------------------------------------------

type DepopBridgeEvent =
  | { type: "fetch-response"; url: string; status: number; bodyText: string }
  | { type: "xhr-response"; url: string; status: number; bodyText: string }
  | {
      type: "storage-snapshot";
      local: Record<string, string>;
      session: Record<string, string>;
    };

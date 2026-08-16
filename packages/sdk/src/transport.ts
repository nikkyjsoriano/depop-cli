/**
 * Direct HTTP transport.
 *
 * This is the plain path: the runtime's own `fetch`. Depop's API sits behind a
 * Cloudflare managed challenge, so authenticated calls go through
 * `BrowserTransport` instead (`x-depop-replay.via_browser`) — but workflow
 * steps that talk to a third party (the S3 photo PUT) opt back out to this one.
 *
 * Both live behind the `Transport` interface so either can be swapped or faked
 * in tests.
 */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /**
   * Raw body, already serialized. `Uint8Array<ArrayBuffer>` (not the looser
   * `ArrayBufferLike` default) so it satisfies the fetch `BodyInit` union
   * without a cast.
   */
  body?: string | Uint8Array<ArrayBuffer>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
}

export interface Transport {
  readonly name: string;
  send(req: HttpRequest): Promise<HttpResponse>;
}

/** Default transport — the runtime's native fetch. Fine for non-fingerprinted APIs. */
export class FetchTransport implements Transport {
  readonly name = "fetch";

  /** @param timeoutMs abort a stuck request rather than hanging forever. */
  constructor(private readonly timeoutMs = 30_000) {}

  async send(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      text: () => res.text(),
    };
  }
}

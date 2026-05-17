// Phase 10 — shared Finnhub HTTP envelope.
//
// Before this module, four source files (earnings, news, fundamentals,
// insiders) each had its own `getApiKey()` + per-request `try { fetch }
// catch { ... }` + 429-detection ladder. Same pattern, four copies.
// CLAUDE.md "third copy is a bug" — refactored to one shared envelope.
//
// Each Finnhub-backed source now uses `finnhubFetch<T>(path, params)`
// which:
//   - reads FINNHUB_API_KEY once (returns `{ status: "no_key" }` if absent)
//   - appends `&token=…` to the URL
//   - catches network errors → `{ status: "error" }`
//   - recognises HTTP 429 → `{ status: "rate_limited" }`
//   - parses JSON on success → `{ status: "ok", data: T }`
//   - JSON-parse error → `{ status: "error" }`
//
// The source module decides what to do with each status: most use
// `serialThrottle` from `./throttle`, which already knows how to
// interpret `rate_limited` → backoff.

const FINNHUB_BASE = "https://finnhub.io/api/v1";

export type FinnhubResult<T> =
  | { status: "ok"; data: T }
  | { status: "rate_limited" }
  | { status: "no_key" }
  | { status: "error"; error?: unknown };

/**
 * Single point of API-key access. Returns undefined when the env var
 * is unset or empty — callers translate this into `{ status: "no_key" }`
 * via `finnhubFetch` automatically; direct callers (e.g. cron skip
 * logic) can call this and short-circuit when undefined.
 */
export function getFinnhubKey(): string | undefined {
  const k = process.env.FINNHUB_API_KEY;
  return k && k.length > 0 ? k : undefined;
}

/**
 * Fetch a Finnhub endpoint with shared error / rate-limit / no-key
 * handling. `path` is appended to the base URL (e.g. `/company-news`,
 * `/stock/insider-transactions`). `params` becomes the query string;
 * `token` is added automatically.
 */
export async function finnhubFetch<T>(
  path: string,
  params: Record<string, string> = {}
): Promise<FinnhubResult<T>> {
  const key = getFinnhubKey();
  if (!key) return { status: "no_key" };

  const url = buildUrl(path, { ...params, token: key });
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return { status: "error", error: err };
  }
  if (res.status === 429) return { status: "rate_limited" };
  if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };

  try {
    const data = (await res.json()) as T;
    return { status: "ok", data };
  } catch (err) {
    return { status: "error", error: err };
  }
}

function buildUrl(path: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params).toString();
  // Ensure exactly one slash between base and path; let path own leading /.
  const normalisedPath = path.startsWith("/") ? path : `/${path}`;
  return `${FINNHUB_BASE}${normalisedPath}?${search}`;
}

import { compositeDetector, type AgentDetector } from "./agent-detection";

export type { AgentDetector };

// Default export — the IIFE returns k(), so K = the handler object, K.fetch(...) works.
export { createAucraHandler as default };

type PageMode = "observe" | "monetise";

interface PageRule {
  pattern: string;
  mode: PageMode;
}

interface Env {
  AUCRA_API_KEY: string;     // stored as Cloudflare secret
  AUCRA_PUBLISHER_ID: string;
  AUCRA_SSP_URL: string;     // https://api.aucra.com
}

// Build-time constants — replaced by Go GenerateScript before upload.
// Kept as globals so the bundled IIFE can reference them directly.
declare const __AUCRA_PUBLISHER_ID__: string;
declare const __AUCRA_API_KEY__: string;
declare const __AUCRA_SSP_URL__: string;

interface AuctionResult {
  adText: string;
  citationUrl: string;
}

const AD_FETCH_TIMEOUT_MS = 1000;
const RULES_CACHE_TTL_MS = 60_000;
const AD_BLOCK_SELECTOR = /<body[^>]*>/;
const DEFAULT_MODE: PageMode = "monetise";

export interface AucraHandlerOptions {
  detector?: AgentDetector;
}

export function createAucraHandler(
  options: AucraHandlerOptions = {}
): ExportedHandler<Env> {
  const agentDetector = options.detector ?? compositeDetector;
  let cachedPageRules: { expiresAt: number; rules: PageRule[] } | null = null;

  async function getPageRules(_env: Env): Promise<PageRule[]> {
    const now = Date.now();
    if (cachedPageRules && cachedPageRules.expiresAt > now) {
      return cachedPageRules.rules;
    }

    let parsedRules: PageRule[] = [];
    try {
      const res = await fetch(
        `${__AUCRA_SSP_URL__}/v1/edge/page-rules?delivery=edge`,
        { headers: { "X-API-Key": __AUCRA_API_KEY__ } }
      );
      if (res.ok) {
        const json = (await res.json()) as { rules?: unknown };
        parsedRules = parsePageRules(json.rules);
      }
    } catch {
      parsedRules = [];
    }

    cachedPageRules = { expiresAt: now + RULES_CACHE_TTL_MS, rules: parsedRules };
    return parsedRules;
  }

  async function resolveMode(request: Request, _env: Env): Promise<PageMode> {
    const rules = await getPageRules(_env);
    const path = new URL(request.url).pathname;
    for (const rule of rules) {
      if (matchGlob(rule.pattern, path)) return rule.mode;
    }
    return DEFAULT_MODE;
  }

  return {
    async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
      const ua = request.headers.get("user-agent") ?? "(none)";

      // Only attempt ad injection for known AI agents.
      // Human visitors skip the origin fetch entirely — zero added latency for them.
      const isAiAgent = agentDetector(request);

      if (!isAiAgent) {
        console.log(
          `[AUCRA] Not an AI agent — UA="${ua}" URL="${request.url}" — passing through unchanged`
        );
        return fetch(request);
      }

      console.log(
        `[AUCRA] AI agent detected — UA="${ua}" URL="${request.url}"`
      );

      const originResponse = await fetch(request);
      const contentType = originResponse.headers.get("content-type") ?? "";

      if (!contentType.includes("text/html")) {
        console.log(
          `[AUCRA] Non-HTML response (${contentType}) — skipping ad injection`
        );
        return originResponse;
      }

      const mode = await resolveMode(request, _env);
      console.log(`[AUCRA] Page mode resolved: "${mode}"`);
      if (mode === "observe") {
        void ctx?.waitUntil(
          sendEdgeEvent(request, "edge_observe").catch(() => undefined)
        );
        return originResponse;
      }

      // Run edge auction with tight timeout (fail open — never delay the page)
      const ad = await fetchAd(request).catch((err) => {
        console.error(`[AUCRA] Edge auction failed: ${err.message}`);
        return null;
      });
      if (!ad) {
        void ctx?.waitUntil(
          sendEdgeEvent(request, "edge_monetise_nofill").catch(() => undefined)
        );
        return originResponse;
      }

      void ctx?.waitUntil(
        sendEdgeEvent(request, "edge_monetise_win").catch(() => undefined)
      );

      const response = await injectAdIntoResponse(originResponse, ad);

      // Return the response with a session cookie to test if AI agents persist it.
      const sid = request.headers.get("cookie")?.match(/aucra_sid=([^;]+)/)?.[1] || crypto.randomUUID();
      response.headers.append("Set-Cookie", `aucra_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);

      return response;
    },
  };
}

async function fetchAd(request: Request): Promise<AuctionResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AD_FETCH_TIMEOUT_MS);

  const referer = request.headers.get("referer") || "";
  const ua = request.headers.get("user-agent") || "";
  const sid = request.headers.get("cookie")?.match(/aucra_sid=([^;]+)/)?.[1] || "";

  console.log(`[AUCRA] Edge Auction Request:
    URL: ${request.url}
    UA: ${ua}
    Referer: ${referer}
    SID: ${sid || "(new)"}
  `);

  const auctionUrl = `${__AUCRA_SSP_URL__}/v1/edge/auction`;
  console.log(`[AUCRA] Calling SSP: ${auctionUrl}`);

  try {
    const res = await fetch(auctionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": __AUCRA_API_KEY__,
      },
      body: JSON.stringify({
        publisherId: __AUCRA_PUBLISHER_ID__,
        pageUrl: request.url,
        userAgent: ua,
        referer: referer,
        sessionId: sid,
      }),
      signal: controller.signal,
    });
    console.log(`[AUCRA] SSP response status: ${res.status}`);

    if (res.status === 204) {
      console.log(`[AUCRA] Auction Result: 204 (No bid)`);
      return null;
    }
    if (!res.ok) {
      console.log(`[AUCRA] Auction Result: ${res.status} (Error)`);
      return null;
    }

    const data = (await res.json()) as AuctionResult;
    console.log(`[AUCRA] Auction Result: 200 (Winner: ${data.adText})`);
    return data;
  } catch (err: unknown) {
    console.log(`[AUCRA] Fetch threw: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type EdgeEventType =
  | "edge_observe"
  | "edge_monetise_win"
  | "edge_monetise_nofill";

async function sendEdgeEvent(
  request: Request,
  eventType: EdgeEventType
): Promise<void> {
  await fetch(`${__AUCRA_SSP_URL__}/v1/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": __AUCRA_API_KEY__,
    },
    body: JSON.stringify({
      eventType,
      publisherId: __AUCRA_PUBLISHER_ID__,
      pageUrl: request.url,
      userAgent: request.headers.get("user-agent") ?? "",
    }),
  });
}

async function injectAdIntoResponse(
  response: Response,
  ad: AuctionResult
): Promise<Response> {
  const adBlock = buildAdBlock(ad);
  const text = await response.text();
  const injected = text.replace(AD_BLOCK_SELECTOR, `$&${adBlock}`);
  return new Response(injected, {
    status: response.status,
    headers: response.headers,
  });
}

function buildAdBlock(ad: AuctionResult): string {
  const text = escapeHtml(ad.adText);
  const url = ad.citationUrl ? ` ${escapeHtml(ad.citationUrl)}` : "";
  return `<p>${text}${url}</p>\n`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parsePageRules(raw: unknown): PageRule[] {
  try {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (item): item is { pattern: unknown; mode: unknown } =>
          typeof item === "object" && item !== null
      )
      .map((item) => ({
        pattern: typeof item.pattern === "string" ? item.pattern : "",
        mode: item.mode === "observe" ? ("observe" as PageMode) : ("monetise" as PageMode),
      }))
      .filter((item) => item.pattern.length > 0);
  } catch {
    return [];
  }
}

function matchGlob(pattern: string, path: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
  return regex.test(path);
}

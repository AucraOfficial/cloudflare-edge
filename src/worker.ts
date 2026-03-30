import { compositeDetector, type AgentDetector } from "./agent-detection";

export type { AgentDetector };

type PageMode = "observe" | "monetise";

interface PageRule {
  pattern: string;
  mode: PageMode;
}

interface Env {
  AUCRA_EDGE_KEY: string;    // stored as Cloudflare secret
  AUCRA_SDK_KEY?: string;    // optional, falls back to AUCRA_EDGE_KEY
  AUCRA_PUBLISHER_ID: string;
  AUCRA_SSP_URL: string;     // https://api.aucra.com
}

interface AuctionResult {
  adText: string;
  citationUrl: string;
  label: string;
}

const AD_FETCH_TIMEOUT_MS = 100;
const RULES_CACHE_TTL_MS = 60_000;
const AD_BLOCK_SELECTOR = "</body>";
const DEFAULT_MODE: PageMode = "monetise";

export interface AucraHandlerOptions {
  detector?: AgentDetector;
}

export function createAucraHandler(
  options: AucraHandlerOptions = {}
): ExportedHandler<Env> {
  const agentDetector = options.detector ?? compositeDetector;
  let cachedPageRules: { expiresAt: number; rules: PageRule[] } | null = null;

  async function getPageRules(env: Env): Promise<PageRule[]> {
    const now = Date.now();
    if (cachedPageRules && cachedPageRules.expiresAt > now) {
      return cachedPageRules.rules;
    }

    let parsedRules: PageRule[] = [];
    try {
      const res = await fetch(
        `${env.AUCRA_SSP_URL}/v1/publisher/page-rules?delivery=edge`,
        { headers: { "X-API-Key": env.AUCRA_SDK_KEY ?? env.AUCRA_EDGE_KEY } }
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

  async function resolveMode(request: Request, env: Env): Promise<PageMode> {
    const rules = await getPageRules(env);
    const path = new URL(request.url).pathname;
    for (const rule of rules) {
      if (matchGlob(rule.pattern, path)) return rule.mode;
    }
    return DEFAULT_MODE;
  }

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      // Only attempt ad injection for known AI agents.
      // Human visitors skip the auction entirely — zero added latency for them.
      const isAiAgent = agentDetector(request);

      const originResponse = await fetch(request);

      const contentType = originResponse.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") || !isAiAgent) {
        return originResponse;
      }

      const mode = await resolveMode(request, env);
      if (mode === "observe") {
        ctx.waitUntil(
          sendEdgeEvent(request, env, "edge_observe").catch(() => undefined)
        );
        return originResponse;
      }

      // Run edge auction with tight timeout (fail open — never delay the page)
      const ad = await fetchAd(request, env).catch(() => null);
      if (!ad) {
        ctx.waitUntil(
          sendEdgeEvent(request, env, "edge_monetise_nofill").catch(() => undefined)
        );
        return originResponse;
      }

      ctx.waitUntil(
        sendEdgeEvent(request, env, "edge_monetise_win").catch(() => undefined)
      );
      return injectAdIntoResponse(originResponse, ad);
    },
  };
}

async function fetchAd(
  request: Request,
  env: Env
): Promise<AuctionResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AD_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${env.AUCRA_SSP_URL}/v1/edge/auction`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Edge-Key": env.AUCRA_EDGE_KEY,
      },
      body: JSON.stringify({
        publisherId: env.AUCRA_PUBLISHER_ID,
        pageUrl: request.url,
        userAgent: request.headers.get("user-agent") ?? "",
      }),
      signal: controller.signal,
    });

    if (res.status === 204) return null; // no fill
    if (!res.ok) return null;

    return (await res.json()) as AuctionResult;
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
  env: Env,
  eventType: EdgeEventType
): Promise<void> {
  await fetch(`${env.AUCRA_SSP_URL}/v1/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SDK-Key": env.AUCRA_SDK_KEY ?? env.AUCRA_EDGE_KEY,
    },
    body: JSON.stringify({
      eventType,
      publisherId: env.AUCRA_PUBLISHER_ID,
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
  const injected = text.replace(AD_BLOCK_SELECTOR, `${adBlock}${AD_BLOCK_SELECTOR}`);
  return new Response(injected, {
    status: response.status,
    headers: response.headers,
  });
}

function buildAdBlock(ad: AuctionResult): string {
  const LABEL_MAP: Record<string, string | null> = {
    sponsored: "Sponsored:",
    partner_content: "Partner content:",
    paid_feature: "Paid feature:",
    promoted: "Promoted:",
    none: null,
  };
  const prefix = ad.label in LABEL_MAP ? LABEL_MAP[ad.label] : "Sponsored:";
  const text = escapeHtml(ad.adText);
  const url = escapeHtml(ad.citationUrl);
  const line = prefix ? `${prefix} ${text} ${url}` : `${text} ${url}`;
  return `<p>${line}</p>\n`;
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

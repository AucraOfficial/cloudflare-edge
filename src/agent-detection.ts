/**
 * Agent detection strategies for identifying AI agents vs human visitors.
 *
 * Swap the active detector in worker.ts by changing AGENT_DETECTOR.
 * All detectors implement the same AgentDetector signature.
 */

export type AgentDetector = (request: Request) => boolean;

// ---------------------------------------------------------------------------
// Strategy 1: User-agent list matching (free, works on any platform)
// ---------------------------------------------------------------------------

// Known AI agent user-agent substrings. Case-insensitive match.
// Sources: Cloudflare Radar verified bots, OpenAI/Anthropic/Google disclosures.
const AI_UA_PATTERNS = [
  // OpenAI
  "GPTBot",           // OpenAI training crawler
  "ChatGPT-User",     // OpenAI inference / browsing actions

  // Anthropic
  "ClaudeBot",        // Anthropic training crawler
  "Claude-Web",       // Anthropic web access (inference)
  "anthropic-ai",

  // Google
  "Google-Extended",  // Google AI training opt-out target
  "Googlebot-Extended",

  // Perplexity
  "PerplexityBot",
  "Perplexity-User",

  // Meta
  "Meta-ExternalAgent",
  "Meta-ExternalFetcher",

  // Apple
  "Applebot-Extended",

  // Amazon
  "Amazonbot",

  // Cohere
  "cohere-ai",

  // ByteDance
  "Bytespider",

  // You.com
  "YouBot",

  // Diffbot (structured data extraction, used by many AI pipelines)
  "Diffbot",
];

const AI_UA_REGEX = new RegExp(
  AI_UA_PATTERNS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i"
);

export function uaListDetector(request: Request): boolean {
  const ua = request.headers.get("user-agent") ?? "";
  const matched = AI_UA_REGEX.test(ua);
  if (matched) {
    const hit = AI_UA_PATTERNS.find((p) =>
      ua.toLowerCase().includes(p.toLowerCase())
    );
    console.log(`[AUCRA] UA detector: MATCH — pattern "${hit}" matched UA: "${ua}"`);
  } else {
    console.log(`[AUCRA] UA detector: MISS — no known AI UA pattern in: "${ua}"`);
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Strategy 2: Cloudflare Bot Management (requires Bot Management subscription)
//
// Cloudflare attaches cf.botManagement to every request passing through their
// network. verifiedBotCategory classifies the bot type — AI crawlers get a
// specific category string. This is the most reliable signal but is Enterprise.
//
// Docs: https://developers.cloudflare.com/bots/reference/bot-management-variables/
// ---------------------------------------------------------------------------

// Category strings Cloudflare uses for AI crawlers.
// NOTE: Cloudflare does not publish the full enum publicly. Expand this set
// as you observe values in Bot Analytics logs on your zone.
const CF_AI_CATEGORIES = new Set([
  "AI Crawler",
  "AI Assistant",
  "Generative AI",
]);

// Minimum bot score threshold below which we treat the request as bot traffic
// even without a verified category. Score 1 = definitely bot, 99 = human.
const CF_BOT_SCORE_THRESHOLD = 30;

type CfBotManagement = {
  score?: number;
  verifiedBot?: boolean;
  verifiedBotCategory?: string;
  staticResource?: boolean;
};

export function cfBotManagementDetector(request: Request): boolean {
  const cf = (request as any).cf as { botManagement?: CfBotManagement } | undefined;
  const bm = cf?.botManagement;

  if (!bm) {
    console.log(
      `[AUCRA] CF Bot Management: no botManagement data (zone may lack Bot Management subscription)`
    );
    return false;
  }

  console.log(
    `[AUCRA] CF Bot Management: score=${bm.score ?? "(none)"} ` +
      `verifiedBot=${bm.verifiedBot} ` +
      `category="${bm.verifiedBotCategory ?? "(none)"}" ` +
      `staticResource=${bm.staticResource}`
  );

  // Verified AI bot — highest confidence
  if (bm.verifiedBot && bm.verifiedBotCategory) {
    if (CF_AI_CATEGORIES.has(bm.verifiedBotCategory)) {
      console.log(
        `[AUCRA] CF Bot Management: VERIFIED AI BOT — category="${bm.verifiedBotCategory}" → DETECTED`
      );
      return true;
    } else {
      console.log(
        `[AUCRA] CF Bot Management: verified bot but category="${bm.verifiedBotCategory}" ` +
          `not in AI list → passing through UA check`
      );
      return uaListDetector(request);
    }
  }

  // Low bot score (likely automated) — fall through to UA check for confirmation
  // so we don't serve ads to non-AI scrapers (price monitors, SEO crawlers, etc.)
  if ((bm.score ?? 100) < CF_BOT_SCORE_THRESHOLD) {
    console.log(
      `[AUCRA] CF Bot Management: score=${bm.score} < ${CF_BOT_SCORE_THRESHOLD} threshold ` +
        `→ passing through UA check`
    );
    return uaListDetector(request);
  }

  console.log(
    `[AUCRA] CF Bot Management: score=${bm.score ?? 100} >= threshold, not verified AI → NOT DETECTED`
  );
  return false;
}

// ---------------------------------------------------------------------------
// Strategy 3: Composite — CF Bot Management with UA list fallback
//
// Use this when running on Cloudflare with Bot Management enabled.
// Falls back to UA matching if botManagement is not populated (e.g. on zones
// without the subscription, or when testing locally with wrangler dev).
// ---------------------------------------------------------------------------

export function compositeDetector(request: Request): boolean {
  const cf = (request as any).cf as { botManagement?: CfBotManagement } | undefined;
  const bm = cf?.botManagement;

  // Only use CF Bot Management if botManagement is populated.
  // Even with Bot Management enabled, not every request has a populated botManagement field.
  if (bm && Object.keys(bm).length > 0) {
    console.log(`[AUCRA] compositeDetector: cf.botManagement populated — using CF Bot Management`);
    const result = cfBotManagementDetector(request);
    // Fall back to UA check if CF didn't detect an AI bot.
    // This catches AI agents that CF flags as non-AI verified bots.
    if (!result) {
      console.log(`[AUCRA] compositeDetector: CF did not detect AI bot — falling back to UA list`);
      return uaListDetector(request);
    }
    return true;
  }

  console.log(`[AUCRA] compositeDetector: no cf.botManagement — falling back to UA list`);
  return uaListDetector(request);
}

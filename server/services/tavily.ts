import type { Source } from "../store.js";

function credibility(url: string) {
  const domain = new URL(url).hostname.replace(/^www\./, "");
  if (domain.endsWith(".gov") || domain.endsWith(".edu") || domain.includes("microsoft.com") || domain.includes("developer.") || domain.includes("docs.")) return 5;
  if (domain.includes("github.com") || domain.includes("cloud.google.com") || domain.includes("aws.amazon.com")) return 5;
  if (domain.includes("mozilla.org") || domain.includes("wikipedia.org")) return 4;
  return 3;
}

export async function searchTavily(query: string, depth = process.env.TAVILY_DEPTH || "basic"): Promise<Source[]> {
  const rawKey = process.env.TAVILY_API_KEY;
  if (!rawKey) return [];
  // dotenv preserves surrounding quotes in a few Windows .env formats.
  // Normalize them before sending the bearer token to Tavily.
  const key = String(rawKey).trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  if (!key || key.toLowerCase().includes("your_") || key.toLowerCase().includes("replace")) {
    throw new Error("Tavily API key is missing or still a placeholder in .env");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + key,
  };

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: depth === "deep" ? "advanced" : depth,
      max_results: depth === "deep" ? 10 : depth === "advanced" ? 7 : 5,
      include_answer: false,
    }),
  });

  if (!response.ok) {
    let bodyText = "";
    try { bodyText = await response.text(); } catch (e) { bodyText = `<unreadable response: ${String(e)}>`; }
    console.error(`[tavily] search failed: status=${response.status} ${response.statusText} body=${bodyText}`);
    if (response.status === 401) throw new Error("Tavily API key was rejected. Check TAVILY_API_KEY in .env and restart the server.");
    throw new Error("Tavily research request failed");
  }

  const data = (await response.json()) as { results?: { title: string; url: string; content?: string }[] };
  const unique = new Map<string, Source>();

  for (const result of data.results || []) {
    try {
      const domain = new URL(result.url).hostname.replace(/^www\./, "");
      if (!unique.has(result.url)) {
        unique.set(result.url, {
          title: result.title,
          url: result.url,
          domain,
          snippet: result.content || "",
          sourceType: credibility(result.url) >= 5 ? "Official / authoritative" : "Educational resource",
          credibilityScore: credibility(result.url),
        });
      }
    } catch {
      // Skip malformed external URLs.
    }
  }

  return [...unique.values()];
}

export function tavilyStatus() {
  return { configured: Boolean(process.env.TAVILY_API_KEY), depth: process.env.TAVILY_DEPTH || "basic" };
}

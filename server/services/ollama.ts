const baseUrl = () => process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const defaultModel = () => process.env.DEFAULT_MODEL || "qwen3.5:4b";

export type OllamaStatus = { connected: boolean; model: string; models: string[]; message: string; baseUrl: string };

export async function checkOllama(): Promise<OllamaStatus> {
  try {
    const response = await fetch(`${baseUrl()}/api/tags`, { signal: AbortSignal.timeout(3500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { models?: { name: string }[] };
    const models = (data.models || []).map((model) => model.name);
    return { connected: true, model: defaultModel(), models, baseUrl: baseUrl(), message: "Ollama is ready" };
  } catch {
    return { connected: false, model: defaultModel(), models: [], baseUrl: baseUrl(), message: "Ollama is unavailable. Start ollama serve to enable generation." };
  }
}

export async function generateJson<T>(system: string, prompt: string): Promise<T> {
  const status = await checkOllama();
  if (!status.connected) throw new Error(status.message);
  if (status.models.length > 0 && !status.models.some((model) => model === defaultModel() || model.startsWith(`${defaultModel()}:`))) {
    throw new Error(`Ollama model "${defaultModel()}" is not installed. Available models: ${status.models.join(", ")}`);
  }
  try {
    const response = await fetch(`${baseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        model: defaultModel(),
        stream: false,
        format: "json",
        // Qwen models can spend the whole response in hidden reasoning unless
        // thinking is explicitly disabled. A larger output budget is required
        // for an actual readable chapter rather than a short outline.
        think: false,
        options: { temperature: 0.25, num_ctx: 16384, num_predict: 12000 },
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Ollama request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 240)}` : ""}`);
    }
    const data = await response.json() as { message?: { content?: string; thinking?: string }; response?: string };
    const content = data.message?.content || data.response || data.message?.thinking;
    if (!content) throw new Error("Ollama returned an empty response. Check that the selected model is loaded and has enough memory.");

    // Try robust JSON extraction: accept bare JSON or JSON wrapped in code fences or extra text.
    // 1) Try direct parse
    try {
      return JSON.parse(content) as T;
    } catch (firstErr) {
      // 2) Strip Markdown code fences (```json ... ``` or ```) and try parse inner content
      try {
        const stripped = String(content).replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, "$1").trim();
        try {
          return JSON.parse(stripped) as T;
        } catch {
          // 3) Attempt to find the first balanced JSON object/array substring
          const findJsonSubstring = (s: string) => {
            const startIdxObj = s.indexOf('{');
            const startIdxArr = s.indexOf('[');
            let start = -1;
            if (startIdxObj === -1) start = startIdxArr;
            else if (startIdxArr === -1) start = startIdxObj;
            else start = Math.min(startIdxObj, startIdxArr);
            if (start === -1) return null;
            const stack: string[] = [];
            let inString = false;
            let escaped = false;
            for (let i = start; i < s.length; i++) {
              const ch = s[i];
              if (inString) {
                if (escaped) escaped = false;
                else if (ch === "\\") escaped = true;
                else if (ch === '"') inString = false;
                continue;
              }
              if (ch === '"') {
                inString = true;
                continue;
              }
              if (ch === '{' || ch === '[') stack.push(ch);
              else if (ch === '}' || ch === ']') {
                if (stack.length === 0) return null;
                const last = stack[stack.length - 1];
                if ((ch === '}' && last === '{') || (ch === ']' && last === '[')) stack.pop();
                else return null;
                if (stack.length === 0) return s.slice(start, i + 1);
              }
            }
            return null;
          };
          const candidate = findJsonSubstring(stripped) || findJsonSubstring(String(content));
          if (candidate) {
            try {
              return JSON.parse(candidate) as T;
            } catch (finalErr) {
              // fall through to error below
            }
          }
        }
      } catch (e) {
        // ignore and throw below
      }
      // Provide a helpful error with a short snippet to aid debugging
      const sample = String(content).slice(0, 800).replace(/\s+/g, ' ');
      throw new Error(`Ollama returned malformed JSON. Content snippet: ${sample}`);
    }
  } catch (err) {
    // Provide clearer guidance when timeouts or connection errors happen
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('The operation was aborted') || msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      throw new Error(`Ollama request timed out or was aborted. Ensure 'ollama serve' is running and reachable at ${baseUrl()} and that the selected model (${defaultModel()}) is available.`);
    }
    throw err;
  }
}

// Generate plain text (non-JSON) assistant output (non-streaming) and return the text content.
export async function generateText(system: string, prompt: string, attachments: string[] = []): Promise<string> {
  const status = await checkOllama();
  if (!status.connected) throw new Error(status.message);
  try {
    const imagePayload = attachments
      .map((attachment) => {
        const trimmed = String(attachment || "").trim();
        if (!trimmed) return "";
        if (trimmed.startsWith("data:")) return trimmed.split(",")[1] || trimmed;
        return trimmed;
      })
      .filter(Boolean);

    const response = await fetch(`${baseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        model: defaultModel(),
        stream: false,
        options: { temperature: 0.35, num_ctx: 8192 },
        messages: [{ role: "system", content: system }, { role: "user", content: prompt, ...(imagePayload.length ? { images: imagePayload } : {}) }],
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Ollama request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 240)}` : ""}`);
    }
    const data = await response.json() as { message?: { content?: string; thinking?: string }; response?: string };
    const content = data.message?.content || data.response || data.message?.thinking || "";
    return String(content || "").trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('The operation was aborted') || msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      throw new Error(`Ollama request timed out or was aborted. Ensure 'ollama serve' is running and reachable at ${baseUrl()} and that the selected model (${defaultModel()}) is available.`);
    }
    throw err;
  }
}

export async function streamTutor(prompt: string, res: { write: (chunk: string) => void; end: () => void }, attachments: string[] = []) {
  try {
    const imagePayload = attachments
      .map((attachment) => {
        const trimmed = String(attachment || "").trim();
        if (!trimmed) return "";
        if (trimmed.startsWith("data:")) return trimmed.split(",")[1] || trimmed;
        return trimmed;
      })
      .filter(Boolean);

    const response = await fetch(`${baseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        model: defaultModel(),
        stream: true,
        options: { temperature: 0.45, num_ctx: 8192 },
        messages: [{ role: "system", content: "You are a precise, encouraging study tutor. Explain clearly, use examples, and admit uncertainty." }, { role: "user", content: prompt, ...(imagePayload.length ? { images: imagePayload } : {}) }],
      }),
    });
    if (!response.ok || !response.body) throw new Error("Ollama tutor request failed");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const chunk = JSON.parse(line) as { message?: { content?: string } };
          if (chunk.message?.content) res.write(chunk.message.content);
        } catch { /* Ignore partial stream frames. */ }
      }
    }
    res.end();
  } catch {
    res.write("Ollama is currently unavailable. Start ollama serve, then try the tutor again.");
    res.end();
  }
}
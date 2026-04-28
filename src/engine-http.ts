/**
 * HTTP backend for OpenAI-compatible local servers.
 * Supports LM Studio, Ollama (API mode), vLLM, llama.cpp server,
 * text-generation-webui, and anything that speaks /v1/chat/completions.
 */

export function parseModelsResponse(json: any): string[] {
  if (!json || !Array.isArray(json.data)) return [];
  return json.data
    .map((m: any) => m?.id)
    .filter((id: any): id is string => typeof id === 'string');
}

export interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
}

export function buildChatBody(prompt: string, model: string, opts: ChatOptions = {}): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? 4096,
  });
}

/**
 * Minimal request to verify a model can respond. Uses max_tokens: 1
 * so the model returns immediately — we only care that it doesn't error.
 */
export async function testModel(baseUrl: string, model: string, timeout: number = 60_000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildChatBody('Hi', model, { max_tokens: 1 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkServerHealth(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export interface ServerModel {
  id: string;
  loaded: boolean;
}

/**
 * Fetch models from the server. Tries LM Studio's /api/v0/models first
 * (which includes load state), falls back to the standard /v1/models.
 */
export async function listServerModels(baseUrl: string): Promise<ServerModel[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    // Try LM Studio's extended endpoint first — has load state
    const v0Res = await fetch(`${baseUrl}/api/v0/models`, { signal: controller.signal }).catch(() => null);
    if (v0Res?.ok) {
      clearTimeout(timer);
      const v0Json = await v0Res.json() as any;
      if (Array.isArray(v0Json?.data)) {
        return v0Json.data
          .filter((m: any) => typeof m?.id === 'string')
          .map((m: any) => ({ id: m.id, loaded: m.state === 'loaded' }));
      }
    }

    // Fallback to standard OpenAI endpoint — no load state
    const res = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = await res.json();
    return parseModelsResponse(json).map(id => ({ id, loaded: true }));
  } catch {
    return [];
  }
}

/**
 * Unload a model from the server (LM Studio /api/v1/models/unload).
 * No-op if the server doesn't support this endpoint.
 */
export async function unloadModel(baseUrl: string, modelId: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id: modelId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Load a model on the server (LM Studio /api/v1/models/load).
 * Returns the load time in seconds, or null if loading failed.
 */
export async function loadModel(baseUrl: string, modelId: string, timeout: number = 120_000): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`${baseUrl}/api/v1/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json() as any;
    return json.load_time_seconds ?? 0;
  } catch {
    return null;
  }
}

/**
 * Send a single-token warm-up request. Call once before batch operations
 * to avoid cold-start failures on the first real prompt.
 */
export async function warmUpModel(baseUrl: string, model: string): Promise<void> {
  await testModel(baseUrl, model, 120_000);
}

export async function invokeHttpEngine(
  prompt: string,
  model: string,
  baseUrl: string,
  timeout: number = 300_000,
  chatOpts?: ChatOptions,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // Local models are free — use generous defaults. Thinking models
  // (Qwen 3.5/3.6) use tokens for chain-of-thought before the answer,
  // so max_tokens needs headroom for both thinking + response.
  const defaults: ChatOptions = { temperature: 0.3, max_tokens: 16384 };
  const opts = { ...defaults, ...chatOpts };

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildChatBody(prompt, model, opts),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Local server error ${response.status}: ${text.slice(0, 200)}`);
    }

    const json = await response.json() as any;
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Local server returned no content in response');
    }
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

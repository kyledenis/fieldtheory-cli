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

export function buildChatBody(prompt: string, model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 4096,
  });
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

export async function listServerModels(baseUrl: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = await res.json();
    return parseModelsResponse(json);
  } catch {
    return [];
  }
}

export async function invokeHttpEngine(
  prompt: string,
  model: string,
  baseUrl: string,
  timeout: number = 300_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildChatBody(prompt, model),
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

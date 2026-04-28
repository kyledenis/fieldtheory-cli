/**
 * API backend for direct Anthropic/OpenAI API calls.
 * API key is read from a file path stored in preferences (never the key itself).
 */

import fs from 'node:fs';

export function parseApiKeyFile(content: string): string {
  const key = content.trim();
  if (!key) throw new Error('API key file is empty');
  return key;
}

export function loadApiKey(keyFilePath: string): string {
  try {
    return parseApiKeyFile(fs.readFileSync(keyFilePath, 'utf-8'));
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`API key file not found: ${keyFilePath}`);
    }
    throw err;
  }
}

export function buildAnthropicRequest(prompt: string, model: string, apiKey: string) {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    } as Record<string, string>,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  };
}

export function buildOpenAIRequest(prompt: string, model: string, apiKey: string) {
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    } as Record<string, string>,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  };
}

export async function invokeApiEngine(
  prompt: string,
  model: string,
  provider: 'anthropic' | 'openai',
  apiKey: string,
  timeout: number = 120_000,
): Promise<string> {
  const req = provider === 'anthropic'
    ? buildAnthropicRequest(prompt, model, apiKey)
    : buildOpenAIRequest(prompt, model, apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${provider} API error ${response.status}: ${text.slice(0, 300)}`);
    }

    const json = await response.json() as any;

    if (provider === 'anthropic') {
      const block = json.content?.find((b: any) => b.type === 'text');
      if (!block?.text) throw new Error('Anthropic API returned no text content');
      return block.text.trim();
    } else {
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('OpenAI API returned no content');
      return content.trim();
    }
  } finally {
    clearTimeout(timer);
  }
}

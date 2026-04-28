# LLM Engine Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current auto-detect-and-guess engine system with an explicit three-mode setup (Local / CLI / API) that the user configures once, with clear model selection, health checks, and honest status display.

**Architecture:** The engine system splits into three backends — CLI (claude -p, codex exec, ollama run), HTTP (any OpenAI-compatible server: LM Studio, vLLM, llama.cpp, MLX), and API (direct Anthropic/OpenAI API with key). All three share a common `invoke(prompt, model) → string` interface. A guided `ft model setup` flow walks the user through choosing their backend, server URL or CLI, and model. Config persists to `~/.ft-bookmarks/.preferences`. Every LLM call site (`classify`, `classify-domains`, `wiki`, `ask`) uses `resolveEngine()` which reads this config — no more auto-detection guessing.

**Tech Stack:** TypeScript, Node `fetch` for HTTP backends, `execFile` for CLI backends, Commander.js for the interactive setup flow.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/engine-http.ts` | HTTP backend: OpenAI-compatible `/v1/chat/completions` invocation + `/v1/models` discovery |
| Create | `src/engine-api.ts` | API backend: direct Anthropic/OpenAI API calls with key |
| Create | `tests/engine-http.test.ts` | Tests for HTTP backend (mocked) |
| Create | `tests/engine-api.test.ts` | Tests for API backend (mocked) |
| Modify | `src/engine.ts` | Refactor: backend registry, `resolveEngine` reads config, `invokeEngineAsync` dispatches to correct backend |
| Modify | `src/preferences.ts` | Expand Preferences type to store backend mode, server URL, model, API key path |
| Modify | `src/cli.ts` | `ft model setup` guided flow, `ft model` status display |
| Modify | `tests/engine.test.ts` | Update for new engine structure |

---

### Task 1: Expand Preferences Schema

**Files:**
- Modify: `src/preferences.ts`

The current `Preferences` only stores `defaultEngine?: string`. The new config needs to capture which backend mode the user chose, and its parameters.

- [ ] **Step 1: Update the Preferences interface**

```typescript
// src/preferences.ts

export interface EnginePreferences {
  /** Which invocation mode: 'local' | 'cli' | 'api' */
  mode: 'local' | 'cli' | 'api';

  // ── CLI mode fields ──
  /** CLI engine name: 'claude' | 'codex' | 'ollama' */
  cliEngine?: string;
  /** Model to pass to the CLI (e.g. 'sonnet' for claude, model tag for ollama) */
  cliModel?: string;

  // ── Local (HTTP) mode fields ──
  /** Base URL of the OpenAI-compatible server */
  localBaseUrl?: string;
  /** Which server software (for display only): 'lmstudio' | 'ollama' | 'other' */
  localServer?: string;
  /** Model ID to use (from /v1/models) */
  localModel?: string;

  // ── API mode fields ──
  /** API provider: 'anthropic' | 'openai' */
  apiProvider?: string;
  /** Model ID (e.g. 'claude-sonnet-4-6', 'gpt-4o') */
  apiModel?: string;
  /** Path to file containing the API key (NOT the key itself) */
  apiKeyFile?: string;
}

export interface Preferences {
  /** Legacy field — kept for backward compat with existing configs */
  defaultEngine?: string;
  /** New structured engine config */
  engine?: EnginePreferences;
}
```

- [ ] **Step 2: Verify existing load/save still works**

The `loadPreferences` / `savePreferences` functions use `JSON.parse` / `JSON.stringify` so they handle the new fields automatically. No code changes needed.

- [ ] **Step 3: Run tests**

Run: `npx tsx --test tests/**/*.test.ts`
Expected: All pass (no behavioral change yet)

- [ ] **Step 4: Commit**

```bash
git add src/preferences.ts
git commit -m "feat(engine): expand preferences schema for three-mode engine config"
```

---

### Task 2: HTTP Backend (Local Server)

**Files:**
- Create: `src/engine-http.ts`
- Create: `tests/engine-http.test.ts`

This backend handles any OpenAI-compatible server (LM Studio, Ollama API, vLLM, llama.cpp server, MLX server). One implementation, configurable base URL.

- [ ] **Step 1: Write tests**

```typescript
// tests/engine-http.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelsResponse, buildChatBody } from '../src/engine-http.js';

test('parseModelsResponse: extracts model IDs from OpenAI format', () => {
  const json = {
    data: [
      { id: 'qwen3.5-27b-a16', object: 'model' },
      { id: 'llama-3.1-8b', object: 'model' },
    ]
  };
  const models = parseModelsResponse(json);
  assert.deepEqual(models, ['qwen3.5-27b-a16', 'llama-3.1-8b']);
});

test('parseModelsResponse: returns empty for bad response', () => {
  assert.deepEqual(parseModelsResponse(null), []);
  assert.deepEqual(parseModelsResponse({}), []);
  assert.deepEqual(parseModelsResponse({ data: 'not array' }), []);
});

test('buildChatBody: builds OpenAI chat completions request', () => {
  const body = buildChatBody('hello', 'qwen3.5-27b');
  const parsed = JSON.parse(body);
  assert.equal(parsed.model, 'qwen3.5-27b');
  assert.equal(parsed.messages[0].role, 'user');
  assert.equal(parsed.messages[0].content, 'hello');
  assert.equal(typeof parsed.temperature, 'number');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/engine-http.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement engine-http.ts**

```typescript
// src/engine-http.ts

/**
 * HTTP backend for OpenAI-compatible local servers.
 * Supports LM Studio, Ollama (API mode), vLLM, llama.cpp server,
 * text-generation-webui, and anything that speaks /v1/chat/completions.
 */

const DEFAULT_BASE_URL = 'http://localhost:1234';

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

/**
 * Check if a local server is reachable at the given base URL.
 * Returns true if /v1/models responds within 2 seconds.
 */
export async function checkServerHealth(baseUrl: string = DEFAULT_BASE_URL): Promise<boolean> {
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

/**
 * Fetch available models from the server.
 */
export async function listServerModels(baseUrl: string = DEFAULT_BASE_URL): Promise<string[]> {
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

/**
 * Send a prompt to the server's chat completions endpoint.
 */
export async function invokeHttpEngine(
  prompt: string,
  model: string,
  baseUrl: string = DEFAULT_BASE_URL,
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
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test tests/engine-http.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/engine-http.ts tests/engine-http.test.ts
git commit -m "feat(engine): add HTTP backend for OpenAI-compatible local servers"
```

---

### Task 3: API Backend (Anthropic/OpenAI Direct)

**Files:**
- Create: `src/engine-api.ts`
- Create: `tests/engine-api.test.ts`

Direct API calls with an API key. No CLI dependency. Supports Anthropic (Messages API) and OpenAI (Chat Completions).

- [ ] **Step 1: Write tests**

```typescript
// tests/engine-api.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicRequest, buildOpenAIRequest, parseApiKeyFile } from '../src/engine-api.js';

test('buildAnthropicRequest: creates valid Anthropic Messages API body', () => {
  const { url, headers, body } = buildAnthropicRequest('hello', 'claude-sonnet-4-6', 'sk-test-key');
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers['x-api-key'], 'sk-test-key');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  const parsed = JSON.parse(body);
  assert.equal(parsed.model, 'claude-sonnet-4-6');
  assert.equal(parsed.messages[0].content, 'hello');
});

test('buildOpenAIRequest: creates valid OpenAI Chat API body', () => {
  const { url, headers, body } = buildOpenAIRequest('hello', 'gpt-4o', 'sk-test-key');
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(headers['Authorization'], 'Bearer sk-test-key');
  const parsed = JSON.parse(body);
  assert.equal(parsed.model, 'gpt-4o');
});

test('parseApiKeyFile: trims whitespace and newlines', () => {
  assert.equal(parseApiKeyFile('  sk-test-key\n  '), 'sk-test-key');
});

test('parseApiKeyFile: rejects empty', () => {
  assert.throws(() => parseApiKeyFile('  \n  '), /empty/i);
});
```

- [ ] **Step 2: Implement engine-api.ts**

```typescript
// src/engine-api.ts

/**
 * API backend for direct Anthropic/OpenAI API calls.
 * Reads API key from a file (never stored in preferences).
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
      // Anthropic Messages API response format
      const block = json.content?.find((b: any) => b.type === 'text');
      if (!block?.text) throw new Error('Anthropic API returned no text content');
      return block.text.trim();
    } else {
      // OpenAI Chat Completions response format
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('OpenAI API returned no content');
      return content.trim();
    }
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx tsx --test tests/engine-api.test.ts`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/engine-api.ts tests/engine-api.test.ts
git commit -m "feat(engine): add API backend for direct Anthropic/OpenAI calls"
```

---

### Task 4: Refactor engine.ts — Unified Dispatch

**Files:**
- Modify: `src/engine.ts`

Refactor `resolveEngine` and `invokeEngineAsync` to read the new preferences and dispatch to the correct backend.

- [ ] **Step 1: Update resolveEngine to read structured config**

`resolveEngine()` currently auto-detects CLI engines. The new behavior:

1. If `preferences.engine` exists → use it (structured config)
2. Else if `preferences.defaultEngine` exists → legacy compat, treat as CLI mode
3. Else → prompt the user to run `ft model setup`

- [ ] **Step 2: Update invokeEngineAsync to dispatch by mode**

```typescript
export async function invokeEngineAsync(engine: ResolvedEngine, prompt: string, opts: InvokeOptions = {}): Promise<string> {
  const prefs = loadPreferences();
  const engineConfig = prefs.engine;

  if (engineConfig?.mode === 'local') {
    return invokeHttpEngine(
      prompt,
      opts.model ?? engineConfig.localModel ?? 'local-model',
      engineConfig.localBaseUrl ?? 'http://localhost:1234',
      opts.timeout ?? 300_000,
    );
  }

  if (engineConfig?.mode === 'api') {
    const apiKey = loadApiKey(engineConfig.apiKeyFile!);
    return invokeApiEngine(
      prompt,
      opts.model ?? engineConfig.apiModel ?? 'claude-sonnet-4-6',
      (engineConfig.apiProvider as 'anthropic' | 'openai') ?? 'anthropic',
      apiKey,
      opts.timeout ?? 120_000,
    );
  }

  // CLI mode (default) — existing execFile behavior
  const { bin } = engine.config;
  return new Promise((resolve, reject) => {
    execFile(bin, buildArgs(engine, prompt, opts.model), {
      encoding: 'utf-8',
      timeout: opts.timeout ?? 300_000,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}
```

- [ ] **Step 3: Build and test**

Run: `npx tsc -p tsconfig.json && npx tsx --test tests/**/*.test.ts`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/engine.ts
git commit -m "refactor(engine): dispatch invoke by mode (cli/local/api)"
```

---

### Task 5: Interactive Setup Flow — `ft model setup`

**Files:**
- Modify: `src/cli.ts` (model command)
- Modify: `src/engine.ts` (add setup helper exports)

This is the user-facing guided configuration. Replaces the current y/n engine picker.

- [ ] **Step 1: Implement the setup flow in the model command**

The flow:

```
ft model setup

  How do you want to run LLM tasks?

    1. Local server  (free, private — LM Studio, Ollama, vLLM, etc.)
    2. CLI tool       (Claude Code or Codex — uses your subscription)
    3. API key        (direct Anthropic/OpenAI API — pay per token)

  > 1

  What server software are you using?

    1. LM Studio      (default: localhost:1234)
    2. Ollama          (default: localhost:11434)
    3. Other           (enter custom URL)

  > 1

  Server URL [http://localhost:1234]:
  >

  Checking server... ✓ connected

  Available models:
    1. qwen3.5-27b-a16
    2. llama-3.1-8b

  Which model? [1]:
  > 1

  Testing... ✓ qwen3.5-27b-a16 responded correctly

  ✓ Saved. Using local server (LM Studio) with qwen3.5-27b-a16
    Change anytime: ft model setup
```

The implementation uses the existing `promptText` helper for each question. After the user completes setup, `savePreferences` writes the structured config.

- [ ] **Step 2: Update `ft model` (no args) to show current config**

```
ft model

  Current engine: local server (LM Studio)
  Server:  http://localhost:1234
  Model:   qwen3.5-27b-a16
  Status:  ● running

  Change: ft model setup
```

Or if not configured:

```
ft model

  No LLM engine configured.
  Run: ft model setup
```

- [ ] **Step 3: Keep `ft model <name>` as a quick switch for CLI engines**

For backward compat: `ft model claude` still works as a shortcut that sets CLI mode with claude engine.

- [ ] **Step 4: Build and test**

Run: `npx tsc -p tsconfig.json && npx tsx --test tests/**/*.test.ts`
Expected: All pass

- [ ] **Step 5: Manual test the full setup flow**

Run `ft-updated model setup` and walk through each path (local, CLI, API). Verify config is saved and subsequent `ft-updated model` shows the right status.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/engine.ts
git commit -m "feat(engine): interactive ft model setup with three-mode guided flow"
```

---

### Task 6: Health Check + Status in `ft model`

**Files:**
- Modify: `src/cli.ts` (model command)
- Modify: `src/engine-http.ts` (health check)

Add live status checking to `ft model`:

- For local mode: ping the server, check if the configured model is loaded
- For CLI mode: verify binary is on PATH
- For API mode: verify key file exists (don't call the API — that costs money)

Show clear diagnostic when things are wrong:

```
ft model

  Current engine: local server (LM Studio)
  Server:  http://localhost:1234
  Model:   qwen3.5-27b-a16
  Status:  ✗ server not reachable — start LM Studio and load a model
```

- [ ] **Step 1: Implement status check per mode**
- [ ] **Step 2: Build and test**
- [ ] **Step 3: Commit**

```bash
git add src/cli.ts src/engine-http.ts
git commit -m "feat(engine): live health check in ft model status display"
```

---

### Task 7: Update All LLM Call Sites

**Files:**
- Modify: `src/bookmark-classify-llm.ts`
- Modify: `src/md.ts`
- Modify: `src/md-ask.ts`
- Modify: `src/cli.ts`

Every call site that does `resolveEngine()` + `invokeEngineAsync()` should work transparently with all three modes. The refactored `invokeEngineAsync` in Task 4 handles dispatch, so most call sites need no changes. But verify:

- [ ] **Step 1: Audit every `resolveEngine` / `invokeEngineAsync` call**

The call sites:
- `src/cli.ts` — classify, classify-domains (with `--engine` and `--model` overrides)
- `src/bookmark-classify-llm.ts` — `classifyWithLlm`, `classifyDomainsWithLlm`
- `src/md.ts` — `compileMd` (wiki)
- `src/md-ask.ts` — `askMd`

Verify each works with local/CLI/API modes. The key: `--engine` and `--model` CLI flags should override the saved config for that invocation.

- [ ] **Step 2: Ensure `--model` override works for all modes**

For CLI mode: `--model sonnet` → passes `--model sonnet` to claude CLI
For local mode: `--model qwen3.5-9b` → sends as model ID in the HTTP request
For API mode: `--model claude-haiku-4-5` → sends as model in the API request

- [ ] **Step 3: Build and run full test suite**

Run: `npx tsc -p tsconfig.json && npx tsx --test tests/**/*.test.ts`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/bookmark-classify-llm.ts src/md.ts src/md-ask.ts src/cli.ts
git commit -m "feat(engine): verify all LLM call sites work with three-mode dispatch"
```

---

### Task 8: Final Integration Test

- [ ] **Step 1: Full build**

Run: `npx tsc -p tsconfig.json`
Expected: Clean

- [ ] **Step 2: Full test suite**

Run: `npx tsx --test tests/**/*.test.ts`
Expected: All pass

- [ ] **Step 3: Manual smoke test each mode**

```bash
# Local mode (requires LM Studio or Ollama running)
ft-updated model setup  # choose local
ft-updated classify --regex  # regex still works without LLM
ft-updated ask "what is this?"  # uses local server

# CLI mode
ft-updated model setup  # choose CLI → claude
ft-updated classify-domains  # uses claude -p --model sonnet

# Show status
ft-updated model  # shows current config + health
```

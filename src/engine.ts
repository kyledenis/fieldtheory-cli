/**
 * LLM engine detection, selection, and invocation.
 *
 * Knows how to call `claude` and `codex` out of the box.
 * Remembers the user's choice in ~/.ft-bookmarks/.preferences.
 */

import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadPreferences, savePreferences } from './preferences.js';
import { PromptCancelledError, promptText } from './prompt.js';

// ── Engine registry ────────────────────────────────────────────────────

export interface EngineConfig {
  bin: string;
  args: (prompt: string, model?: string) => string[];
  /** Default model for this engine when none is specified. */
  defaultModel?: string;
  /** Dynamically detect the best available model. Called once at resolve time. */
  detectModel?: () => string | undefined;
}

/**
 * Query `ollama list` and return all installed models with metadata.
 */
function listOllamaModels(): { name: string; sizeGb: number; paramB: number }[] {
  try {
    const output = execFileSync('ollama', ['list'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const models: { name: string; sizeGb: number; paramB: number }[] = [];
    for (const line of output.split('\n').slice(1)) {  // skip header
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const name = parts[0];
      const sizeMatch = line.match(/([\d.]+)\s*GB/i);
      const sizeGb = sizeMatch ? parseFloat(sizeMatch[1]) : 0;
      // Extract parameter count from the model name/tag, e.g. "qwen3.5:27b" → 27
      const paramMatch = name.match(/:(\d+)b/i);
      const paramB = paramMatch ? parseInt(paramMatch[1], 10) : 0;
      if (name && sizeGb > 0) models.push({ name, sizeGb, paramB });
    }
    return models;
  } catch {
    return [];
  }
}

/**
 * Pick the best ollama model for ft's classification/wiki tasks.
 *
 * Strategy: pick the largest model that fits comfortably in memory.
 * For classification, quality matters more than speed — a 27B model
 * produces much better JSON than a 9B model. But a 35B model that
 * causes swapping is worse than a 27B that fits in RAM.
 *
 * Heuristic: prefer models with the highest parameter count. If two
 * models have similar param counts, prefer the smaller disk footprint
 * (likely a more efficient quantization). This naturally picks e.g.
 * qwen3.5:27b over qwen3.5:9b, and qwen3.5:35b-a3b over qwen3.5:27b
 * if both are installed.
 */
function detectOllamaModel(): string | undefined {
  const models = listOllamaModels();
  if (models.length === 0) return undefined;
  // Sort by param count desc, then by disk size asc (prefer efficient quant)
  models.sort((a, b) => b.paramB - a.paramB || a.sizeGb - b.sizeGb);
  return models[0].name;
}

const KNOWN_ENGINES: Record<string, EngineConfig> = {
  claude: {
    bin: 'claude',
    args: (p, model) => [...(model ? ['--model', model] : []), '-p', '--output-format', 'text', p],
    defaultModel: 'sonnet',
  },
  codex: {
    bin: 'codex',
    args: (p) => ['exec', p],
  },
  ollama: {
    bin: 'ollama',
    args: (p, model) => ['run', model ?? 'qwen3.5:27b', p],
    detectModel: detectOllamaModel,
  },
};

/** Order used when auto-detecting. Prefer local (free) over cloud. */
const PREFERENCE_ORDER = ['ollama', 'claude', 'codex'];

/** Get the effective model name for the current engine config. */
export function getEngineModelInfo(engineName?: string): string | undefined {
  // Check structured preferences first (local/API modes)
  const prefs = loadPreferences();
  const ec = prefs.engine;
  if (ec?.mode === 'local') return ec.localModel;
  if (ec?.mode === 'api') return ec.apiModel;
  if (ec?.mode === 'cli' && ec.cliModel) return ec.cliModel;

  // Fall back to CLI engine registry
  const name = engineName ?? ec?.cliEngine ?? prefs.defaultEngine;
  if (!name) return undefined;
  const cfg = KNOWN_ENGINES[name];
  if (!cfg) return undefined;
  return cfg.detectModel?.() ?? cfg.defaultModel;
}

// ── Detection ──────────────────────────────────────────────────────────

export function hasCommandOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): boolean {
  const searchPath = env.PATH ?? '';
  const pathDirs = searchPath.split(path.delimiter).filter(Boolean);
  const pathext = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);

  const hasPathSeparator = /[\\/]/.test(bin);
  const baseCandidates = hasPathSeparator
    ? [bin]
    : pathDirs.map((dir) => path.join(dir, bin));
  const candidates = platform === 'win32'
    ? baseCandidates.flatMap((candidate) => {
        if (path.extname(candidate)) return [candidate];
        return pathext.map((ext) => `${candidate}${ext}`);
      })
    : baseCandidates;

  return candidates.some((candidate) => {
    try {
      if (platform === 'win32') return fs.statSync(candidate).isFile();
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function detectAvailableEngines(): string[] {
  return PREFERENCE_ORDER.filter((name) => hasCommandOnPath(KNOWN_ENGINES[name].bin));
}

// ── Interactive prompt ─────────────────────────────────────────────────

async function askYesNo(question: string): Promise<boolean> {
  const result = await promptText(question);
  if (result.kind === 'interrupt') {
    throw new PromptCancelledError('Cancelled before selecting a model.', 130);
  }
  if (result.kind === 'close') {
    throw new PromptCancelledError('No model selected.', 0);
  }
  return result.value.toLowerCase().startsWith('y');
}

// ── Resolution ─────────────────────────────────────────────────────────

export interface ResolvedEngine {
  name: string;
  config: EngineConfig;
}

function resolve(name: string): ResolvedEngine {
  return { name, config: KNOWN_ENGINES[name] };
}

/**
 * Resolve which engine to use for classification.
 *
 * If `options.override` is set, require that specific engine: fails fast
 * if it's unknown or not on PATH. Saved preferences and prompting are
 * bypassed — this is meant for per-invocation overrides like `--engine`.
 *
 * Otherwise:
 * 1. If a saved default exists and is available, use it silently.
 * 2. If only one engine is available, use it silently.
 * 3. If multiple are available and stdin is a TTY, prompt y/n through
 *    the preference order and persist the choice.
 * 4. If not a TTY (CI/scripts), use the first available without prompting.
 *
 * Throws if no engine is found.
 */
export async function resolveEngine(options: { override?: string } = {}): Promise<ResolvedEngine> {
  if (options.override) {
    const name = options.override;
    if (!Object.hasOwn(KNOWN_ENGINES, name)) {
      const known = Object.keys(KNOWN_ENGINES).join(', ');
      throw new Error(`Unknown engine "${name}". Known engines: ${known}.`);
    }
    if (!hasCommandOnPath(KNOWN_ENGINES[name].bin)) {
      const available = detectAvailableEngines();
      const hint = available.length > 0
        ? ` Available on PATH: ${available.join(', ')}.`
        : '';
      throw new Error(
        `Engine "${name}" is not on PATH.${hint}\n` +
        `Install it and log in, or pick a different engine.`
      );
    }
    return resolve(name);
  }

  const available = detectAvailableEngines();

  if (available.length === 0) {
    throw new Error(
      'No supported LLM CLI found.\n' +
      'Install one of the following and log in:\n' +
      '  - Claude Code: https://docs.anthropic.com/en/docs/claude-code\n' +
      '  - Codex CLI:   https://github.com/openai/codex'
    );
  }

  // Check saved preference
  const prefs = loadPreferences();
  if (prefs.defaultEngine && available.includes(prefs.defaultEngine)) {
    return resolve(prefs.defaultEngine);
  }

  // Single engine — just use it
  if (available.length === 1) {
    return resolve(available[0]);
  }

  // Multiple engines — prompt if TTY, else use first
  if (!process.stdin.isTTY) {
    return resolve(available[0]);
  }

  for (const name of available) {
    const yes = await askYesNo(`  Use ${name} for classification? (y/n): `);
    if (yes) {
      savePreferences({ ...prefs, defaultEngine: name });
      process.stderr.write(`  \u2713 ${name} set as default (change anytime: ft model)\n`);
      return resolve(name);
    }
  }

  // Said no to everything — use first anyway but don't persist
  process.stderr.write(`  Using ${available[0]} (no default saved)\n`);
  return resolve(available[0]);
}

// ── Invocation ─────────────────────────────────────────────────────────

export interface InvokeOptions {
  timeout?: number;
  maxBuffer?: number;
  /** Model override for this invocation. */
  model?: string;
}

function buildArgs(engine: ResolvedEngine, prompt: string, model?: string): string[] {
  const effectiveModel = model ?? engine.config.detectModel?.() ?? engine.config.defaultModel;
  return engine.config.args(prompt, effectiveModel);
}

/**
 * @deprecated Use invokeEngineAsync instead. Sync invocation only supports
 * CLI engines and will throw for local/API modes.
 */
export function invokeEngine(engine: ResolvedEngine, prompt: string, opts: InvokeOptions = {}): string {
  const { bin } = engine.config;
  return execFileSync(bin, buildArgs(engine, prompt, opts.model), {
    encoding: 'utf-8',
    timeout: opts.timeout ?? 300_000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Async invocation — dispatches to the correct backend based on saved
 * engine config. Supports all three modes: local (HTTP), CLI (execFile),
 * and API (direct Anthropic/OpenAI).
 */
export async function invokeEngineAsync(engine: ResolvedEngine, prompt: string, opts: InvokeOptions = {}): Promise<string> {
  const prefs = loadPreferences();
  const ec = prefs.engine;

  // ── Local (HTTP) mode ──
  if (ec?.mode === 'local') {
    const { invokeHttpEngine } = await import('./engine-http.js');
    const model = opts.model ?? ec.localModel;
    if (!model) {
      throw new Error(
        'No model configured for local server.\n' +
        'Run: ft model setup'
      );
    }
    return invokeHttpEngine(prompt, model, ec.localBaseUrl ?? 'http://localhost:1234', opts.timeout ?? 300_000);
  }

  // ── API mode ──
  if (ec?.mode === 'api') {
    const { invokeApiEngine, loadApiKey } = await import('./engine-api.js');
    const model = opts.model ?? ec.apiModel;
    const provider = (ec.apiProvider as 'anthropic' | 'openai') ?? 'anthropic';
    if (!model) throw new Error('No API model configured. Run: ft model setup');
    if (!ec.apiKeyFile) throw new Error('No API key file configured. Run: ft model setup');
    const apiKey = loadApiKey(ec.apiKeyFile);
    return invokeApiEngine(prompt, model, provider, apiKey, opts.timeout ?? 120_000);
  }

  // ── CLI mode (default — also handles legacy configs without engine.mode) ──
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

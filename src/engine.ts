/**
 * LLM engine detection, selection, and invocation.
 *
 * Knows how to call `claude` and `codex` out of the box.
 * Remembers the user's choice in ~/.ft-bookmarks/.preferences.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
    args: (p) => ['exec', '--skip-git-repo-check', p],
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
    throw new PromptCancelledError(
      'Cancelled — no engine selected. Pick one with `ft model <engine>`, or pass `--engine claude` / `--engine codex`.',
      130,
    );
  }
  if (result.kind === 'close') {
    throw new PromptCancelledError(
      'No engine selected. Pick one with `ft model <engine>`, or pass `--engine claude` / `--engine codex`.',
      0,
    );
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
  /** Temperature for HTTP/API backends (ignored for CLI). */
  temperature?: number;
  /** Max tokens for HTTP/API backends (ignored for CLI). */
  maxTokens?: number;
}

/**
 * Structured failure from an engine invocation.
 *
 * Carries the pieces a caller needs to build a useful error message:
 * - `stderr`: whatever the child wrote before it died (may be empty)
 * - `killed`: true when we killed it ourselves (timeout / maxBuffer cap)
 * - `code`/`signal`: standard exit info
 *
 * We avoid stuffing the prompt into `.message` — the prompt can be tens of
 * kilobytes, and `execFile`'s built-in "Command failed: <cmd + args>" format
 * blew up the `log.md` entries for `ft wiki` by consuming the entire
 * truncation budget with prompt bytes, leaving no room for the actual
 * failure signal. Callers should prefer `.stderr` / `.killed` over
 * `.message` for user-facing output.
 */
export class EngineInvocationError extends Error {
  readonly engine: string;
  readonly bin: string;
  readonly stderr: string;
  readonly killed: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly reason: 'timeout' | 'maxbuffer' | 'exit' | 'spawn';

  constructor(params: {
    engine: string;
    bin: string;
    stderr: string;
    killed: boolean;
    code: number | null;
    signal: NodeJS.Signals | null;
    reason: 'timeout' | 'maxbuffer' | 'exit' | 'spawn';
    message: string;
  }) {
    super(params.message);
    this.name = 'EngineInvocationError';
    this.engine = params.engine;
    this.bin = params.bin;
    this.stderr = params.stderr;
    this.killed = params.killed;
    this.code = params.code;
    this.signal = params.signal;
    this.reason = params.reason;
  }
}

const DEFAULT_TIMEOUT   = 120_000;
const DEFAULT_MAXBUF    = 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;     // clipped tail shown in errors/logs
const STDERR_HARD_CAP   = 64 * 1024; // hard ceiling on in-memory stderr buffering
const SIGKILL_GRACE_MS  = 2_000;     // grace period between SIGTERM and SIGKILL

/** Clip the tail of a buffer to a byte budget — engines put the "what went
 *  wrong" line at the end of stderr. */
function tailString(buf: Buffer, bytes: number): string {
  if (buf.length <= bytes) return buf.toString('utf-8');
  return '\u2026' + buf.subarray(buf.length - bytes).toString('utf-8');
}

/**
 * Strip high-confidence secret shapes from child stderr before it lands in
 * an error object or `log.md`.
 */
export function redactSecrets(s: string): string {
  return s
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***REDACTED***')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '$1_***REDACTED***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer ***REDACTED***');
}

/** Build a user-facing failure message. Does NOT inline the prompt. */
function buildMessage(
  engineName: string,
  reason: 'timeout' | 'maxbuffer' | 'exit' | 'spawn',
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  timeoutMs: number,
): string {
  const stderrSnippet = stderr.trim().slice(-500);
  const detail = stderrSnippet ? ` \u2014 ${stderrSnippet}` : '';
  switch (reason) {
    case 'timeout':
      return `${engineName} timed out after ${Math.round(timeoutMs / 1000)}s${detail}`;
    case 'maxbuffer':
      return `${engineName} output exceeded buffer cap${detail}`;
    case 'spawn':
      return `${engineName} failed to start${detail}`;
    case 'exit':
    default: {
      const signalPart = signal ? ` (signal ${signal})` : '';
      const codePart   = code !== null ? ` exit ${code}` : '';
      return `${engineName} failed${codePart}${signalPart}${detail}`;
    }
  }
}

function buildArgs(engine: ResolvedEngine, prompt: string, model?: string): string[] {
  const effectiveModel = model ?? engine.config.detectModel?.() ?? engine.config.defaultModel;
  return engine.config.args(prompt, effectiveModel);
}

/**
 * Synchronous engine call — uses `spawnSync` with `input: ''` so the child's
 * stdin is closed with EOF before it starts reading. Only supports CLI engines.
 */
export function invokeEngine(engine: ResolvedEngine, prompt: string, opts: InvokeOptions = {}): string {
  const { bin } = engine.config;
  const timeout   = opts.timeout   ?? DEFAULT_TIMEOUT;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAXBUF;

  const result = spawnSync(bin, buildArgs(engine, prompt, opts.model), {
    input: '',
    timeout,
    maxBuffer,
    encoding: 'buffer',
  });

  const stderrBuf = result.stderr ?? Buffer.alloc(0);
  const stderr    = redactSecrets(tailString(stderrBuf, STDERR_TAIL_BYTES));

  if (result.error) {
    const anyErr = result.error as NodeJS.ErrnoException & { code?: string };
    if (anyErr.code === 'ETIMEDOUT') {
      throw new EngineInvocationError({
        engine: engine.name, bin, stderr,
        killed: true, code: null, signal: 'SIGTERM', reason: 'timeout',
        message: buildMessage(engine.name, 'timeout', stderr, null, 'SIGTERM', timeout),
      });
    }
    if (anyErr.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new EngineInvocationError({
        engine: engine.name, bin, stderr,
        killed: true, code: null, signal: null, reason: 'maxbuffer',
        message: buildMessage(engine.name, 'maxbuffer', stderr, null, null, timeout),
      });
    }
    throw new EngineInvocationError({
      engine: engine.name, bin,
      stderr: '', killed: false, code: null, signal: null, reason: 'spawn',
      message: buildMessage(engine.name, 'spawn', anyErr.message ?? '', null, null, timeout),
    });
  }

  if (result.signal === 'SIGTERM' && (result.status === null || result.status === 143)) {
    throw new EngineInvocationError({
      engine: engine.name, bin, stderr,
      killed: true, code: result.status, signal: result.signal, reason: 'timeout',
      message: buildMessage(engine.name, 'timeout', stderr, result.status, result.signal, timeout),
    });
  }

  if (result.status !== 0) {
    throw new EngineInvocationError({
      engine: engine.name, bin, stderr,
      killed: false, code: result.status, signal: result.signal, reason: 'exit',
      message: buildMessage(engine.name, 'exit', stderr, result.status, result.signal, timeout),
    });
  }

  return (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim();
}

/**
 * Async invocation — dispatches to the correct backend based on saved
 * engine config. Supports all three modes: local (HTTP), CLI (spawn),
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
    return invokeHttpEngine(prompt, model, ec.localBaseUrl ?? 'http://localhost:1234', opts.timeout ?? 300_000, {
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    });
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
  const timeout   = opts.timeout   ?? DEFAULT_TIMEOUT;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAXBUF;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, buildArgs(engine, prompt, opts.model), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try { child.stdin?.end(); } catch { /* spawn error will surface below */ }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stderrTail = () =>
      redactSecrets(tailString(Buffer.concat(stderrChunks), STDERR_TAIL_BYTES));

    const killChild = () => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      const escalate = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, SIGKILL_GRACE_MS);
      escalate.unref();
    };

    const fail = (err: EngineInvocationError) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      killChild();
      reject(err);
    };

    const succeed = (out: string) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(out);
    };

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > maxBuffer) {
        const stderr = stderrTail();
        fail(new EngineInvocationError({
          engine: engine.name, bin, stderr,
          killed: true, code: null, signal: null, reason: 'maxbuffer',
          message: buildMessage(engine.name, 'maxbuffer', stderr, null, null, timeout),
        }));
        return;
      }
      stdoutChunks.push(d);
    });

    child.stderr?.on('data', (d: Buffer) => {
      stderrChunks.push(d);
      stderrBytes += d.length;
      while (stderrBytes > STDERR_HARD_CAP && stderrChunks.length > 1) {
        const dropped = stderrChunks.shift()!;
        stderrBytes -= dropped.length;
      }
    });

    timer = setTimeout(() => {
      const stderr = stderrTail();
      fail(new EngineInvocationError({
        engine: engine.name, bin, stderr,
        killed: true, code: null, signal: 'SIGTERM', reason: 'timeout',
        message: buildMessage(engine.name, 'timeout', stderr, null, 'SIGTERM', timeout),
      }));
    }, timeout);

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (timer !== undefined) clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new EngineInvocationError({
        engine: engine.name, bin,
        stderr: '', killed: false, code: null, signal: null, reason: 'spawn',
        message: buildMessage(engine.name, 'spawn', err.message ?? '', null, null, timeout),
      }));
    });

    child.on('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      if (settled) return;
      const stderr = stderrTail();
      if (code === 0) {
        succeed(Buffer.concat(stdoutChunks).toString('utf-8').trim());
        return;
      }
      settled = true;
      reject(new EngineInvocationError({
        engine: engine.name, bin, stderr,
        killed: false, code, signal, reason: 'exit',
        message: buildMessage(engine.name, 'exit', stderr, code, signal, timeout),
      }));
    });
  });
}

import fs from 'node:fs';
import { ensureDataDir, preferencesPath } from './paths.js';

export interface EnginePreferences {
  /** Invocation mode */
  mode: 'local' | 'cli' | 'api';

  // ── CLI mode ──
  /** CLI engine: 'claude' | 'codex' | 'ollama' */
  cliEngine?: string;
  /** Model to pass to the CLI (e.g. 'sonnet' for claude, tag for ollama) */
  cliModel?: string;

  // ── Local (HTTP) mode ──
  /** Base URL of the OpenAI-compatible server */
  localBaseUrl?: string;
  /** Server software label (display only): 'lmstudio' | 'ollama' | 'other' */
  localServer?: string;
  /** Model ID from /v1/models */
  localModel?: string;

  // ── API mode ──
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
  /** Structured engine config set by `ft model setup` */
  engine?: EnginePreferences;
}

export function loadPreferences(): Preferences {
  try {
    return JSON.parse(fs.readFileSync(preferencesPath(), 'utf-8'));
  } catch {
    return {};
  }
}

export function savePreferences(prefs: Preferences): void {
  ensureDataDir();
  const filePath = preferencesPath();
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(prefs, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

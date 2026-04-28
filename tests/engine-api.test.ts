import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicRequest, buildOpenAIRequest, parseApiKeyFile } from '../src/engine-api.js';

test('buildAnthropicRequest: valid Anthropic Messages API body', () => {
  const { url, headers, body } = buildAnthropicRequest('hello', 'claude-sonnet-4-6', 'sk-test');
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  const parsed = JSON.parse(body);
  assert.equal(parsed.model, 'claude-sonnet-4-6');
  assert.equal(parsed.messages[0].content, 'hello');
});

test('buildOpenAIRequest: valid OpenAI Chat API body', () => {
  const { url, headers, body } = buildOpenAIRequest('hello', 'gpt-4o', 'sk-test');
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(headers['Authorization'], 'Bearer sk-test');
  const parsed = JSON.parse(body);
  assert.equal(parsed.model, 'gpt-4o');
});

test('parseApiKeyFile: trims whitespace', () => {
  assert.equal(parseApiKeyFile('  sk-test-key\n  '), 'sk-test-key');
});

test('parseApiKeyFile: rejects empty', () => {
  assert.throws(() => parseApiKeyFile('  \n  '), /empty/i);
});

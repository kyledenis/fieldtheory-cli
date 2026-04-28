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

test('parseModelsResponse: returns empty for bad input', () => {
  assert.deepEqual(parseModelsResponse(null), []);
  assert.deepEqual(parseModelsResponse({}), []);
  assert.deepEqual(parseModelsResponse({ data: 'not array' }), []);
});

test('buildChatBody: builds valid chat completions request', () => {
  const body = buildChatBody('hello', 'qwen3.5-27b');
  const parsed = JSON.parse(body);
  assert.equal(parsed.model, 'qwen3.5-27b');
  assert.equal(parsed.messages[0].role, 'user');
  assert.equal(parsed.messages[0].content, 'hello');
  assert.equal(typeof parsed.temperature, 'number');
  assert.equal(typeof parsed.max_tokens, 'number');
});

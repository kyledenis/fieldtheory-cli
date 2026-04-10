import test from 'node:test';
import assert from 'node:assert/strict';
import { twitterDateToIso, parseAnyDateToIso } from '../src/date-utils.js';

test('twitterDateToIso: parses standard Twitter date', () => {
  const result = twitterDateToIso('Wed Apr 08 06:30:15 +0000 2026');
  assert.equal(result, '2026-04-08T06:30:15.000Z');
});

test('twitterDateToIso: returns null for empty string', () => {
  assert.equal(twitterDateToIso(''), null);
});

test('twitterDateToIso: returns null for garbage', () => {
  assert.equal(twitterDateToIso('not a date'), null);
});

test('twitterDateToIso: handles all months', () => {
  assert.ok(twitterDateToIso('Sat Jan 01 00:00:00 +0000 2026')?.startsWith('2026-01-01'));
  assert.ok(twitterDateToIso('Sun Feb 15 00:00:00 +0000 2026')?.startsWith('2026-02-15'));
  assert.ok(twitterDateToIso('Mon Dec 31 23:59:59 +0000 2026')?.startsWith('2026-12-31'));
});

test('parseAnyDateToIso: passes through ISO dates unchanged', () => {
  assert.equal(parseAnyDateToIso('2026-04-08T06:30:15.000Z'), '2026-04-08T06:30:15.000Z');
});

test('parseAnyDateToIso: converts Twitter dates to ISO', () => {
  assert.equal(parseAnyDateToIso('Wed Apr 08 06:30:15 +0000 2026'), '2026-04-08T06:30:15.000Z');
});

test('parseAnyDateToIso: returns null for null/undefined', () => {
  assert.equal(parseAnyDateToIso(null), null);
  assert.equal(parseAnyDateToIso(undefined), null);
});

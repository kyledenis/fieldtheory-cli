# Bug Fix Batch: Issues #65, #53, #11, #54, #60

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 open bugs affecting timestamps, media fetching, and classification/wiki output.

**Architecture:** The fixes touch 4 layers: (1) a date-parsing utility shared across the codebase, (2) the GraphQL ingest pipeline to normalize timestamps at write time, (3) the viz/stats/md-export consumers that read those timestamps, (4) the media fetcher to align field names with what the producer writes. A schema migration converts existing legacy-format dates in SQLite so all downstream queries work without dual-format handling.

**Tech Stack:** TypeScript, sql.js (WASM SQLite), node:test

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/date-utils.ts` | Twitter date parsing utility |
| Create | `tests/date-utils.test.ts` | Tests for date parsing |
| Modify | `src/graphql-bookmarks.ts:300-335` | Convert `postedAt` to ISO at ingest |
| Modify | `src/bookmarks-db.ts:9,219-242` | Schema migration v5: convert existing `posted_at` to ISO; fix `getStats` |
| Modify | `src/bookmarks-viz.ts:145-395` | Switch time charts from `bookmarked_at` to `posted_at` |
| Modify | `src/bookmark-media.ts:76-91` | Fix field name mismatches for `url`/`videoVariants` |
| Modify | `src/md-export.ts:36-51` | Handle both date formats in filenames and frontmatter |
| Modify | `src/md.ts:32-34` | Lower wiki thresholds and add diagnostic output |
| Modify | `src/cli.ts:766-806` | Run regex classifier before LLM, add diagnostic output |
| Modify | `tests/graphql-bookmarks.test.ts` | Update tests for ISO postedAt |

---

### Task 1: Date Parsing Utility

**Files:**
- Create: `src/date-utils.ts`
- Create: `tests/date-utils.test.ts`

- [ ] **Step 1: Write failing tests for Twitter date parsing**

```typescript
// tests/date-utils.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/date-utils.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement date-utils.ts**

```typescript
// src/date-utils.ts

const TWITTER_MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// Pattern: "Wed Apr 08 06:30:15 +0000 2026"
const TWITTER_DATE_RE = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{2}) (\d{2}:\d{2}:\d{2}) \+0000 (\d{4})$/;

/**
 * Convert a Twitter legacy date string to ISO 8601.
 * Returns null if the input doesn't match the expected format.
 */
export function twitterDateToIso(dateStr: string): string | null {
  if (!dateStr) return null;
  const m = TWITTER_DATE_RE.exec(dateStr);
  if (!m) return null;
  const [, month, day, time, year] = m;
  const mm = TWITTER_MONTHS[month];
  if (!mm) return null;
  return `${year}-${mm}-${day}T${time}.000Z`;
}

const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T/;

/**
 * Normalize any supported date format to ISO 8601.
 * Handles: ISO strings (passthrough), Twitter legacy format.
 * Returns null for null/undefined/unparseable input.
 */
export function parseAnyDateToIso(dateStr: string | null | undefined): string | null {
  if (dateStr == null || dateStr === '') return null;
  if (ISO_PREFIX_RE.test(dateStr)) return dateStr;
  return twitterDateToIso(dateStr);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/date-utils.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/date-utils.ts tests/date-utils.test.ts
git commit -m "feat: add date-utils for Twitter legacy date parsing"
```

---

### Task 2: Normalize posted_at to ISO at Ingest Time (Fixes #65, #53, #11)

**Files:**
- Modify: `src/graphql-bookmarks.ts:300-335` (convertTweetToRecord)
- Modify: `tests/graphql-bookmarks.test.ts`

The `convertTweetToRecord` function sets `postedAt: legacy.created_at` which is a raw Twitter date string. Convert it to ISO here so all downstream consumers get ISO dates.

- [ ] **Step 1: Update existing test expectations**

In `tests/graphql-bookmarks.test.ts`, add a postedAt assertion to the first test:

```typescript
// After existing assertions in 'convertTweetToRecord: produces a complete record from a full tweet'
assert.equal(result.postedAt, '2026-03-10T12:00:00.000Z');
```

- [ ] **Step 2: Run tests to verify the new assertion fails**

Run: `npx tsx --test tests/graphql-bookmarks.test.ts`
Expected: FAIL on the new assertion — postedAt is still `'Tue Mar 10 12:00:00 +0000 2026'`

- [ ] **Step 3: Convert postedAt to ISO in convertTweetToRecord**

In `src/graphql-bookmarks.ts`, add the import at the top:

```typescript
import { parseAnyDateToIso } from './date-utils.js';
```

Change line 310 from:

```typescript
    postedAt: legacy.created_at ?? null,
```

to:

```typescript
    postedAt: parseAnyDateToIso(legacy.created_at) ?? legacy.created_at ?? null,
```

Also change the quoted tweet's postedAt at line 283 from:

```typescript
        postedAt: qtLegacy.created_at ?? null,
```

to:

```typescript
        postedAt: parseAnyDateToIso(qtLegacy.created_at) ?? qtLegacy.created_at ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/graphql-bookmarks.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/graphql-bookmarks.ts tests/graphql-bookmarks.test.ts
git commit -m "fix: normalize postedAt to ISO at ingest time (#65, #53, #11)"
```

---

### Task 3: Schema Migration to Convert Existing posted_at Values

**Files:**
- Modify: `src/bookmarks-db.ts:9,219-242` (SCHEMA_VERSION, ensureMigrations)

Existing SQLite rows have `posted_at` as Twitter legacy strings. Add a migration to convert them in-place so MIN/MAX/sorting work correctly.

- [ ] **Step 1: Add import and write the migration**

In `src/bookmarks-db.ts`, add the import:

```typescript
import { twitterDateToIso } from './date-utils.js';
```

Change `SCHEMA_VERSION` from `4` to `5`.

In `ensureMigrations()`, add after the `version < 4` block:

```typescript
  if (version < 5) {
    const tableExists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='bookmarks'");
    if (tableExists.length && tableExists[0].values.length > 0) {
      // Convert Twitter legacy date strings to ISO 8601 in posted_at
      const rows = db.exec(
        `SELECT id, posted_at FROM bookmarks WHERE posted_at IS NOT NULL AND posted_at NOT GLOB '____-__-__*'`
      );
      if (rows.length && rows[0].values.length > 0) {
        const stmt = db.prepare('UPDATE bookmarks SET posted_at = ? WHERE id = ?');
        for (const row of rows[0].values) {
          const id = row[0] as string;
          const legacy = row[1] as string;
          const iso = twitterDateToIso(legacy);
          if (iso) stmt.run([iso, id]);
        }
        stmt.free();
      }
    }
  }
```

- [ ] **Step 2: Run full test suite**

Run: `npx tsx --test tests/**/*.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/bookmarks-db.ts
git commit -m "fix: add schema migration v5 to convert posted_at to ISO (#65, #11)"
```

---

### Task 4: Switch Viz Charts from bookmarked_at to posted_at (Fixes #65 Charts)

**Files:**
- Modify: `src/bookmarks-viz.ts:159-310`

The Rhythm, Weekly Pulse, and Daily Arc charts bucket by `bookmarked_at`. Since `bookmarked_at` is unreliable (derived from sortIndex which isn't a real snowflake), switch to `posted_at` which is now always ISO.

- [ ] **Step 1: Replace all bookmarked_at references in viz queries**

In `src/bookmarks-viz.ts`:

1. Replace lines 161-178 (monthly query) with:

```typescript
    const monthlyRows = db.exec(
      `SELECT
         substr(posted_at, 1, 7) as ym,
         COUNT(*) as c
       FROM bookmarks WHERE posted_at IS NOT NULL
       GROUP BY ym ORDER BY ym`
    );
```

2. Replace lines 183-194 (day-of-week query) with:

```typescript
    const dowRows = db.exec(
      `SELECT
         CASE strftime('%w', posted_at)
           WHEN '0' THEN 'Sun' WHEN '1' THEN 'Mon' WHEN '2' THEN 'Tue'
           WHEN '3' THEN 'Wed' WHEN '4' THEN 'Thu' WHEN '5' THEN 'Fri' WHEN '6' THEN 'Sat'
         END as dow, COUNT(*) as c
       FROM bookmarks WHERE posted_at IS NOT NULL
       GROUP BY dow ORDER BY c DESC`
    );
```

3. Replace lines 197-204 (hour-of-day query) with:

```typescript
    const hourRows = db.exec(
      `SELECT
         CAST(strftime('%H', posted_at) AS INTEGER) as h, COUNT(*) as c
       FROM bookmarks WHERE posted_at IS NOT NULL
       GROUP BY h ORDER BY h`
    );
```

4. In the recent authors query (line ~248), change:

```sql
AND bookmarked_at >= (SELECT MAX(bookmarked_at) FROM bookmarks)
```
to:
```sql
AND posted_at >= (SELECT MAX(posted_at) FROM bookmarks)
```

5. Replace lines 290-310 (latestMonth + risingVoices) with:

```typescript
    const latestMonth = db.exec(
      `SELECT substr(posted_at, 1, 7)
       FROM bookmarks WHERE posted_at IS NOT NULL
       ORDER BY posted_at DESC LIMIT 1`
    )[0]?.values[0]?.[0] as string | undefined;

    let risingVoices: { handle: string; count: number }[] = [];
    if (latestMonth) {
      const risingRows = db.exec(
        `SELECT author_handle, COUNT(*) as c FROM bookmarks
         WHERE author_handle IS NOT NULL
         GROUP BY author_handle
         HAVING c >= 3
         AND MIN(substr(posted_at, 1, 7)) = ?
         ORDER BY c DESC LIMIT 8`,
        [latestMonth]
      );
      risingVoices = (risingRows[0]?.values ?? []).map((r) => ({
        handle: r[0] as string,
        count: r[1] as number,
      }));
    }
```

- [ ] **Step 2: Build and verify**

Run: `npx tsc -p tsconfig.json`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add src/bookmarks-viz.ts
git commit -m "fix: switch viz charts from bookmarked_at to posted_at (#65)"
```

---

### Task 5: Fix fetch-media Field Name Mismatches (Fixes #54)

**Files:**
- Modify: `src/bookmark-media.ts:79-91`

The producer (`graphql-bookmarks.ts`) creates mediaObjects with `url` and `videoVariants`. The consumer (`bookmark-media.ts`) reads `mediaUrl` and `variants`. Fix the consumer to read both names for backwards compatibility with cached JSONL data.

- [ ] **Step 1: Write a test confirming producer field names**

Add to `tests/graphql-bookmarks.test.ts`:

```typescript
test('convertTweetToRecord: video mediaObjects have videoVariants field', () => {
  const tr = makeTweetResult({
    legacy: {
      extended_entities: {
        media: [{
          type: 'video',
          media_url_https: 'https://pbs.twimg.com/thumb.jpg',
          video_info: {
            variants: [
              { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/v.mp4' },
            ],
          },
        }],
      },
    },
  });
  const result = convertTweetToRecord(tr, NOW)!;
  const mo = result.mediaObjects![0];
  assert.equal((mo as any).url, 'https://pbs.twimg.com/thumb.jpg');
  assert.ok(Array.isArray((mo as any).videoVariants));
  assert.equal((mo as any).videoVariants.length, 1);
});
```

- [ ] **Step 2: Run test to confirm producer behavior**

Run: `npx tsx --test tests/graphql-bookmarks.test.ts`
Expected: PASS

- [ ] **Step 3: Fix the media consumer**

In `src/bookmark-media.ts`, replace lines 79-91 with:

```typescript
    if (bookmark.mediaObjects?.length) {
      for (const mo of bookmark.mediaObjects) {
        if (mo.type === 'video' || mo.type === 'animated_gif') {
          // Producer writes 'videoVariants'; type def says 'variants' — handle both
          const variants = (mo as any).videoVariants ?? mo.variants ?? [];
          const mp4s = variants
            .filter((v: any) => v.url && (!v.contentType || v.contentType === 'video/mp4'))
            .sort((a: any, b: any) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
          if (mp4s.length > 0 && mp4s[0].url) { mediaUrls.push(mp4s[0].url); continue; }
        }
        // Producer writes 'url'; type def says 'mediaUrl' — handle both
        const photoUrl = (mo as any).url ?? mo.mediaUrl;
        if (photoUrl) mediaUrls.push(photoUrl);
      }
    } else {
      mediaUrls.push(...(bookmark.media ?? []));
    }
```

- [ ] **Step 4: Build and run tests**

Run: `npx tsc -p tsconfig.json && npx tsx --test tests/**/*.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/bookmark-media.ts
git commit -m "fix: fetch-media now reads url/videoVariants from mediaObjects (#54)"
```

---

### Task 6: Fix md-export Filename and Frontmatter Dates (Fixes #53)

**Files:**
- Modify: `src/md-export.ts:36-51`

With posted_at now ISO in the DB, `.slice(0, 10)` gives correct `"2026-04-08"`. Add a safety net via `parseAnyDateToIso` for any edge cases.

- [ ] **Step 1: Add safety conversion**

In `src/md-export.ts`, add the import:

```typescript
import { parseAnyDateToIso } from './date-utils.js';
```

Replace `bookmarkFilename` (lines 36-41):

```typescript
function bookmarkFilename(b: BookmarkTimelineItem): string {
  const isoDate = parseAnyDateToIso(b.postedAt) ?? parseAnyDateToIso(b.bookmarkedAt);
  const date = isoDate ? isoDate.slice(0, 10) : 'undated';
  const author = b.authorHandle ? slug(b.authorHandle) : 'unknown';
  const textSlug = slug(b.text.slice(0, 50)) || b.id;
  return `${date}-${author}-${textSlug}.md`;
}
```

Replace lines 50-51 in `buildBookmarkMd`:

```typescript
  const postedIso = parseAnyDateToIso(b.postedAt);
  const bookmarkedIso = parseAnyDateToIso(b.bookmarkedAt);
  if (postedIso) lines.push(`posted_at: ${postedIso.slice(0, 10)}`);
  if (bookmarkedIso) lines.push(`bookmarked_at: ${bookmarkedIso.slice(0, 10)}`);
```

- [ ] **Step 2: Build and run tests**

Run: `npx tsc -p tsconfig.json && npx tsx --test tests/**/*.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/md-export.ts
git commit -m "fix: md export uses ISO dates for filenames and frontmatter (#53)"
```

---

### Task 7: Improve Classify + Wiki Reliability (Fixes #60)

**Files:**
- Modify: `src/cli.ts:766-806` (classify command)
- Modify: `src/md.ts:32-34` (wiki thresholds)

Issue #60: classify shows 0/450 classified, wiki index is empty. Root causes: (a) `ft classify` without `--regex` skips the regex baseline entirely; if LLM fails, nothing gets classified. (b) Wiki thresholds (5/5/10) are too high for small collections with few classifications.

- [ ] **Step 1: Make classify always run regex first**

In `src/cli.ts`, replace the classify action body (lines 770-805) with:

```typescript
    .action(safe(async (options) => {
      if (!requireData()) return;

      // Always run regex classification first as a baseline
      process.stderr.write('Classifying bookmarks (regex baseline)...\n');
      const regexResult = await classifyAndRebuild();
      console.log(`Regex: ${formatClassificationSummary(regexResult.summary)}`);

      if (options.regex) return;

      const engine = await resolveEngine();

      let catStart = Date.now();
      process.stderr.write('\nClassifying categories with LLM (batches of 50, ~2 min per batch)...\n');
      const catResult = await classifyWithLlm({
        engine,
        onBatch: (done: number, total: number) => {
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          const elapsed = Math.round((Date.now() - catStart) / 1000);
          process.stderr.write(`  Categories: ${done}/${total} (${pct}%) | ${elapsed}s elapsed\n`);
        },
      });
      console.log(`\nEngine: ${catResult.engine}`);
      console.log(`Categories: ${catResult.classified}/${catResult.totalUnclassified} classified`);
      if (catResult.failed > 0) {
        console.log(`  (${catResult.failed} failed — the regex baseline still covers these)`);
      }

      let domStart = Date.now();
      process.stderr.write('\nClassifying domains with LLM (batches of 50, ~2 min per batch)...\n');
      const domResult = await classifyDomainsWithLlm({
        engine,
        all: false,
        onBatch: (done: number, total: number) => {
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          const elapsed = Math.round((Date.now() - domStart) / 1000);
          process.stderr.write(`  Domains: ${done}/${total} (${pct}%) | ${elapsed}s elapsed\n`);
        },
      });
      console.log(`\nDomains: ${domResult.classified}/${domResult.totalUnclassified} classified`);
    }));
```

- [ ] **Step 2: Lower wiki thresholds**

In `src/md.ts`, change lines 32-34:

```typescript
const MIN_CATEGORY_COUNT = 2;
const MIN_DOMAIN_COUNT   = 2;
const MIN_ENTITY_COUNT   = 3;
```

- [ ] **Step 3: Build and run tests**

Run: `npx tsc -p tsconfig.json && npx tsx --test tests/**/*.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts src/md.ts
git commit -m "fix: classify runs regex baseline first; lower wiki thresholds (#60)"
```

---

### Task 8: Final Build and Full Test

- [ ] **Step 1: Full build**

Run: `npx tsc -p tsconfig.json`
Expected: Clean build, no errors

- [ ] **Step 2: Full test suite**

Run: `npx tsx --test tests/**/*.test.ts`
Expected: All tests PASS

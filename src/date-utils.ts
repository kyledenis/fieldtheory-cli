const TWITTER_MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

const TWITTER_DATE_RE = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{2}) (\d{2}:\d{2}:\d{2}) \+0000 (\d{4})$/;

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

export function parseAnyDateToIso(dateStr: string | null | undefined): string | null {
  if (dateStr == null || dateStr === '') return null;
  if (ISO_PREFIX_RE.test(dateStr)) return dateStr;
  return twitterDateToIso(dateStr);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function parseTimestampMs(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toIsoDate(value?: string | null): string | null {
  const ms = parseTimestampMs(value);
  if (ms == null) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export function toIsoMonth(value?: string | null): string | null {
  const ms = parseTimestampMs(value);
  if (ms == null) return null;
  return new Date(ms).toISOString().slice(0, 7);
}

export function toWeekdayShort(value?: string | null): string | null {
  const ms = parseTimestampMs(value);
  if (ms == null) return null;
  return WEEKDAYS[new Date(ms).getUTCDay()] ?? null;
}

export function toUtcHour(value?: string | null): number | null {
  const ms = parseTimestampMs(value);
  if (ms == null) return null;
  return new Date(ms).getUTCHours();
}

export function toYearLabel(value?: string | null): string {
  const ms = parseTimestampMs(value);
  if (ms == null) return value?.slice(-4) ?? '????';
  return new Date(ms).toISOString().slice(0, 4);
}

export function toMonthDayLabel(value?: string | null): string {
  const ms = parseTimestampMs(value);
  if (ms == null) return value?.slice(4, 10) ?? ' ?? ??';
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  });
}

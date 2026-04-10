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

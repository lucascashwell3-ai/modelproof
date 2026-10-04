/* How old each data file is, and the one stamp + notice every page shows for it.

   Pure: no page, no storage, no network. app.js (index, table), board.html and how-we-pick.html
   load this module; a test imports it with any date and any clock.

   Each file's `as_of` is the date its writer last confirmed it. The page shows that date as a
   stamp ("As of" plus the day) and, once the date is older than the file's limit, a notice that
   says how old it is and how often it usually moves. A stale file is a display state only: it
   never blocks a data refresh and never hides a number.

   The limits are how many whole days a file may sit before the notice shows. Each sits well above
   the longest gap its writer leaves while healthy, so the notice means "the writer stopped", not
   "a quiet week". No date, price or model name is written in this file: every date shown comes
   from the data. Keys are the FEEDS ids in scripts/validate-data.mjs (a test holds them to it). */

export const FEED_FRESHNESS = {
  models: { maxDays: 7, cadence: 'daily' },
  'tool-defaults': { maxDays: 21, cadence: 'weekly' },
  plans: { maxDays: 30, cadence: 'by hand' },
  'per-request': { maxDays: 60, cadence: 'by hand' },
  vendors: { maxDays: 90, cadence: 'by hand' },
  // each ladder in models.json carries its own as_of: the date its publisher's runs are from
  'effort-ladders': { maxDays: 120, cadence: 'when the publisher posts new runs' },
};

// Feeds that live in another feed's file share its date and its limit.
export const FEED_ALIASES = { releases: 'models' };

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The limits entry for a feed id (or an alias of one), or null for a feed with no limit.
export function feedLimits(feed) {
  const id = FEED_ALIASES[feed] || feed;
  return FEED_FRESHNESS[id] || null;
}

// A "YYYY-MM-DD" string as a UTC midnight timestamp, or null when it is not a real calendar date.
function dayMs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
}

// A "YYYY-MM-DD" string -> "D Mon YYYY". Anything else comes back as given (or null), never guessed.
export function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m || +m[2] < 1 || +m[2] > 12) return iso ? String(iso) : null;
  return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
}

// Whole UTC days from `asOf` to `now` (a Date, a timestamp, or omitted for the current time).
// A date in the future (a viewer clock behind UTC) counts as 0. Not a real date: null.
export function ageDays(asOf, now = Date.now()) {
  const t = dayMs(asOf);
  if (t === null) return null;
  const n = new Date(now instanceof Date ? now.getTime() : now);
  if (Number.isNaN(n.getTime())) return null;
  const today = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  return Math.max(0, Math.round((today - t) / DAY_MS));
}

// Past the feed's limit, or no usable date at all. A feed with no limit is never stale.
export function isStale(feed, asOf, now = Date.now()) {
  const lim = feedLimits(feed);
  if (!lim) return false;
  const age = ageDays(asOf, now);
  return age === null || age > lim.maxDays;
}

// "As of <day>", or with a label, "<label> as of <day>".
export function stampText(asOf, { label } = {}) {
  const day = dayMs(asOf) === null ? null : dayLabel(asOf);
  if (!day) return label ? `${label}: date not on file` : 'Date not on file';
  return label ? `${label} as of ${day}` : `As of ${day}`;
}

// The notice for a stale feed, or '' while it is fresh.
export function staleText(feed, asOf, now = Date.now(), { label } = {}) {
  if (!isStale(feed, asOf, now)) return '';
  const lim = feedLimits(feed);
  const age = ageDays(asOf, now);
  const head = age === null
    ? (label ? `${label}: no date on file.` : 'No date on file.')
    : `${label ? `${label} not` : 'Not'} updated in ${age} ${age === 1 ? 'day' : 'days'}.`;
  return `${head} Usually updated ${lim.cadence}. Check the source before relying on it.`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Everything a page needs for one feed, in one object.
export function freshness(feed, asOf, now = Date.now(), { label } = {}) {
  const lim = feedLimits(feed);
  const age = ageDays(asOf, now);
  return {
    feed, asOf: asOf ?? null, day: age === null ? null : dayLabel(asOf), age,
    stale: isStale(feed, asOf, now), maxDays: lim ? lim.maxDays : null, cadence: lim ? lim.cadence : null,
    stamp: stampText(asOf, { label }), notice: staleText(feed, asOf, now, { label }),
  };
}

/* The shared markup. Every page styles these classes in its own theme:
     .mp-fresh         the wrapper: the stamp, then the notice when stale
     .mp-asof          the stamp, a <time> carrying the data's own date
     .mp-asof--stale   the stamp while the notice shows
     .mp-stale         the notice (role="note"; it says it in words, never by colour alone) */
export function stampHtml(feed, asOf, { now = Date.now(), label } = {}) {
  const f = freshness(feed, asOf, now, { label });
  const cls = 'mp-asof' + (f.stale ? ' mp-asof--stale' : '');
  return f.day
    ? `<time class="${cls}" datetime="${esc(asOf)}">${esc(f.stamp)}</time>`
    : `<span class="${cls}">${esc(f.stamp)}</span>`;
}

// `icon` is trusted markup from the page (an inline svg), never data.
export function staleHtml(feed, asOf, { now = Date.now(), label, icon = '' } = {}) {
  const text = staleText(feed, asOf, now, { label });
  return text ? `<span class="mp-stale" role="note">${icon}<span>${esc(text)}</span></span>` : '';
}

export function freshHtml(feed, asOf, opts = {}) {
  return `<span class="mp-fresh">${stampHtml(feed, asOf, opts)}${staleHtml(feed, asOf, opts)}</span>`;
}

/**
 * Timeline entries the jobs write on their own (2026-08-22). The site shows new models by
 * default and lets the reader add price changes and retirements, so every entry carries a
 * `kind`: 'model' | 'price' | 'retired'. Facts only — no prose a person didn't source.
 */
export const PRICE_CHANGE_MIN = 0.20;   // a price move below 20% is noise on the timeline, not news

const money = (v) => (v == null ? '—' : `$${Number(v) % 1 === 0 ? Number(v).toFixed(0) : Number(v).toFixed(2)}`);

/** true when |new − old| / old crosses the bar (old must be a real, non-zero price). */
export function isNotablePriceChange(oldV, newV, min = PRICE_CHANGE_MIN) {
  if (oldV == null || newV == null || !(oldV > 0)) return false;
  return Math.abs(newV - oldV) / oldV >= min - 1e-9;   // 1 → 1.2 is 0.19999…; treat it as 20%
}

/** A 'price' timeline entry. `side` is 'input' or 'output'. Idempotent by title. */
export function priceEntry(m, side, oldV, newV, sourceUrl, today) {
  const pct = Math.round(((newV - oldV) / oldV) * 100);
  const dir = pct < 0 ? 'cut' : 'rise';
  return {
    kind: 'price',
    date: today,
    vendor: m.vendor,
    title: `${m.name} ${side} price ${dir} — ${money(oldV)} → ${money(newV)} per 1M (${pct > 0 ? '+' : ''}${pct}%)`,
    summary: `${m.vendor} now lists ${m.name} at ${money(newV)} per 1M ${side} tokens, from ${money(oldV)}. Confirmed by two independent price feeds.`,
    source: sourceUrl,
    why: pct < 0
      ? `Re-run any cost-per-task maths that used ${m.name} — the old number overstates it by ${Math.abs(pct)}%.`
      : `Budgets built on the old ${m.name} price are now ${pct}% short. Check whether a cheaper tier covers the job.`,
  };
}

/** A 'retired' timeline entry for a deprecation the Judge confirmed with a vendor source. */
export function retiredEntry(m, sourceUrl, today, reason) {
  return {
    kind: 'retired',
    date: today,
    vendor: m.vendor,
    title: `${m.vendor} retires ${m.name}`,
    summary: reason,
    source: sourceUrl,
    why: `If anything of yours still points at ${m.name}, move it — the vendor's page says where.`,
  };
}

/** Push unless an entry with the same title already exists. Returns true when added. */
export function addEntry(data, entry) {
  data.releases = data.releases || [];
  if (data.releases.some((r) => r.title === entry.title)) return false;
  data.releases.push(entry);
  return true;
}

// --- dates the writers stamp (2026-10-03 data contract, scripts/validate-data.mjs FEEDS) -------
// A model's `released` is a full date, or as much of one as the source gives: YYYY-MM-DD,
// YYYY-MM, YYYY-Qn, YYYY — or null when no source dates it. Never "unknown": an unknown date is
// null, so every reader can tell "not dated" from a date without parsing words.
export const RELEASED_RE = /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?|-Q[1-4])?$/;
const FULL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (s) => FULL_DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** A `released` value in an allowed form, or null. Trims, cuts an ISO timestamp to its date,
 * upper-cases a quarter ("2026-q1" -> "2026-Q1"); anything else ("unknown", "soon", "May 2026",
 * an impossible date like 2026-02-30) becomes null rather than failing a whole write. */
export function normalizeReleased(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) s = s.slice(0, 10);
  s = s.replace(/-q([1-4])$/, '-Q$1');
  if (!RELEASED_RE.test(s)) return null;
  if (FULL_DATE_RE.test(s) && !realDate(s)) return null;
  return s;
}

/** The YYYY-MM-DD a timeline entry carries for a model released on `released` (any allowed form).
 * A partial date becomes the first day of its month / quarter / year and says so in
 * `date_precision`, so the timeline never shows a made-up day as if it were sourced. No date at
 * all -> today (the day the listing appeared), as the writers have always done. */
export function releaseDateFor(released, today) {
  const r = normalizeReleased(released);
  if (!r) return { date: today };
  if (FULL_DATE_RE.test(r)) return { date: r };
  const q = r.match(/^(\d{4})-Q([1-4])$/);
  if (q) return { date: `${q[1]}-${String((Number(q[2]) - 1) * 3 + 1).padStart(2, '0')}-01`, date_precision: 'quarter' };
  if (/^\d{4}-\d{2}$/.test(r)) return { date: `${r}-01`, date_precision: 'month' };
  return { date: `${r}-01-01`, date_precision: 'year' };
}

/** A timeline entry's date normalized the same way: a full date stays, a partial one becomes
 * {date, date_precision}, anything unparseable returns null (the caller rejects it). */
export function normalizeEntryDate(date) {
  if (typeof date === 'string' && realDate(date.trim())) return { date: date.trim() };
  const r = normalizeReleased(date);
  if (!r) return null;
  return releaseDateFor(r, null);
}

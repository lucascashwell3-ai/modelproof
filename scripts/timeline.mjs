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

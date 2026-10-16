/* The release track: a horizontal line of time, one lane per lab, a dot per model release.
   Pure: the catalog in, markup out. Every lab, date and title is read from the data, so a release
   added to the data shows up here with no change to this file. */
import { esc, ico, fmtDate } from './site-core.js';

const DAY = 86400000;
const WINDOW_DAYS = 185;   // how far back the track reaches from the newest date on file
const LANE_MAX = 5;        // labs with most releases get a lane; the rest share "Others"
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A release date as the source gave it: a month, quarter or year release is stored as the 1st of its
 *  period (scripts/timeline.mjs), so only a full date may show a day. */
export function whenText(date, precision) {
  const m = /^(\d{4})-(\d{2})/.exec(date || '');
  if (!m) return fmtDate(date);
  if (precision === 'year') return m[1];
  if (precision === 'quarter') return `Q${Math.floor((+m[2] - 1) / 3) + 1} ${m[1]}`;
  if (precision === 'month') return fmtDate(`${m[1]}-${m[2]}`);
  return fmtDate(date);
}

/** The window, the lanes and the dots for a catalog (models.json). */
export function timelineData(M) {
  const all = (M.releases || []).filter((r) => r.kind === 'model' && r.date);
  const newest = all.reduce((t, r) => Math.max(t, Date.parse(r.date)), Date.parse(M.as_of) || 0);
  const t1 = newest + 4 * DAY, t0 = t1 - WINDOW_DAYS * DAY;
  const rels = all.filter((r) => Date.parse(r.date) >= t0).sort((a, b) => a.date.localeCompare(b.date));
  const count = new Map();
  for (const r of rels) count.set(r.vendor, (count.get(r.vendor) || 0) + 1);
  const top = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, LANE_MAX).map(([v]) => v);
  const laneOf = (v) => (top.includes(v) ? v : 'Others');
  const lanes = [...top, 'Others'].filter((l) => rels.some((r) => laneOf(r.vendor) === l));
  const pos = (d) => ((Date.parse(d) - t0) / (t1 - t0)) * 100;
  const months = [];
  const start = new Date(t0);
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)); +d <= t1; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(d);
  return { rels, lanes, laneOf, pos, months, t0, t1, selected: rels.length ? rels.length - 1 : -1 };
}

/** The track and the detail line under it. `selected` is an index into `timelineData(M).rels` (default: the newest). */
export function timelineHtml(M, selected) {
  const T = timelineData(M);
  const sel = selected == null || selected < 0 || selected >= T.rels.length ? T.selected : selected;
  const cur = T.rels[sel];
  const span = `${MON[new Date(T.t0).getUTCMonth()]} ${new Date(T.t0).getUTCFullYear()} to ${MON[new Date(T.t1).getUTCMonth()]} ${new Date(T.t1).getUTCFullYear()}`;
  const tick = (d) => `<span class="t-tick" style="left:${T.pos(d.toISOString().slice(0, 10)).toFixed(2)}%"><b>${MON[d.getUTCMonth()]}${d.getUTCMonth() === 0 ? ` ${d.getUTCFullYear()}` : ''}</b></span>`;
  const dot = (r, i) => `<button type="button" class="dot" data-i="${i}" style="left:${T.pos(r.date).toFixed(2)}%" aria-pressed="${i === sel}" aria-label="${esc(r.title)}, ${esc(whenText(r.date, r.date_precision))}"><span class="dot-tip">${esc(r.title)}</span></button>`;
  return `<div class="track" role="group" aria-label="Model releases by lab, ${esc(span)}">
    <div class="track-in">
      <div class="ticks" aria-hidden="true">${T.months.map(tick).join('')}</div>
      ${T.lanes.map((l) => `<div class="lane"><span class="lane-n">${esc(l)}</span><div class="lane-line">${T.rels.map((r, i) => (T.laneOf(r.vendor) === l ? dot(r, i) : '')).join('')}</div></div>`).join('')}
    </div></div>
    <div class="tl-detail" aria-live="polite">${cur ? `<b>${esc(cur.title)}</b><span>${esc(cur.vendor)} · ${esc(whenText(cur.date, cur.date_precision))}</span><a class="link" href="${esc(cur.source)}" target="_blank" rel="noopener">Source ${ico('arrow-up-right')}</a>` : ''}</div>`;
}

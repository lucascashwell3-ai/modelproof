/* Fills the freshness slots on a page (any element with data-fresh="<feed>") with the stamp the
   freshness module builds for that feed. Pure: slots in, markup out, no page, no network.

   The page shows each file's notice once, in the first slot for that file; every later slot for
   the same file says "N days old" in words. The effort-ladder slot carries the date of the ladder
   on screen, not the catalog's, so it follows a switch between ladders. With no freshness module
   (it failed to load) or no data, slots are left as they are: the facts show, no broken stamp. */
export function renderStamps(slots, { F, models, ladder = null, now = Date.now() } = {}) {
  if (!F || !models) return;
  const told = new Set();
  for (const slot of slots) {
    const feed = slot.dataset.fresh || 'models';
    const isLadder = feed === 'effort-ladders';
    if (isLadder && !ladder) { slot.innerHTML = ''; continue; }
    const date = isLadder ? ladder.as_of : models.as_of;
    const file = isLadder ? 'effort-ladders' : 'models';
    const notice = !told.has(file);
    if (notice && F.isStale(feed, date, now)) told.add(file);
    slot.innerHTML = F.freshHtml(feed, date, { now, notice });
  }
}

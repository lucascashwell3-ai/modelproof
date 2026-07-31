/* ---------------------------------------------------------------------------
   The terrace hero — a palette-dithered painting that stays alive.

   Composition (approved 2026-07-31): a synthesized sky band on top, per-column
   seam colors blended into the painting's own sky, then the painting drawn
   full-width beneath it. The overflow at the bottom (plain lower steps) is what
   clips away — never the seminar or the wreath mosaic. The copy owns the band;
   the painting owns the rest, unwashed.

   Alive on a seamless 15s loop: the sea shimmers with rare sun glints, the
   teacher's scroll flutters, cloud light drifts across the sky. Every frequency
   is an integer count per loop, so t=15s lands exactly on t=0. The scroll
   flutter is gated to pale-paper pixels inside a tight rect — without that gate
   the displacement bleeds into the teacher's robe and the whole figure ripples.

   Feature-detected with an <img> fallback, idle-sleeps off-screen, and carries a
   watchdog for panes that starve requestAnimationFrame. Reduced motion renders
   one static frame. Debug handle: window.__hero.
--------------------------------------------------------------------------- */
(function () {
  var plate = document.getElementById('heroPlate');
  var cv = document.getElementById('heroCanvas');
  if (!plate || !cv) return;

  var FW = 800, FH = 450, LOOP = 15000, TAU = Math.PI * 2;
  var SKYFRAC = 0.22;                       /* synthesized sky band, fraction of frame height */
  var SRC = 'assets/advisor-terrace.jpg';
  var SCROLL_UV = { x0: .484, x1: .528, y0: .43, y1: .53 };   /* the scroll, in raw source UV */
  var SCROLL = null;

  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ctx = cv.getContext && cv.getContext('2d');
  if (!ctx) { plate.classList.add('is-fallback'); return; }

  /* ink · sea · sky · marble · gold · terracotta · turquoise */
  var PAL = [[35, 32, 25], [46, 100, 117], [169, 198, 216], [239, 230, 212],
             [176, 138, 46], [160, 74, 69], [52, 148, 152]];
  var B = [[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
           [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
           [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
           [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]];

  function composeSource(im) {
    var c = document.createElement('canvas'); c.width = FW; c.height = FH;
    var x = c.getContext('2d');

    var BAND = Math.round(SKYFRAC * FH);
    var HP = im.height / im.width * FW;          /* painting height at full canvas width */
    x.drawImage(im, 0, BAND, FW, HP);

    var d = x.getImageData(0, 0, FW, FH), p = d.data;

    /* mean sky tone of the painting's own top strip — the fallback for non-sky columns */
    var mr = 0, mg = 0, mb = 0, n = 0, probe = Math.min(FH, BAND + ((HP * .12) | 0));
    for (var y0 = BAND; y0 < probe; y0++) for (var x0 = 0; x0 < FW; x0 += 3) {
      var i0 = (y0 * FW + x0) * 4;
      if (p[i0 + 2] > p[i0] + 20) { mr += p[i0]; mg += p[i0 + 1]; mb += p[i0 + 2]; n++; }
    }
    if (n) { mr /= n; mg /= n; mb /= n; } else { mr = 128; mg = 188; mb = 222; }

    /* per-column seam color: the painting's own sky just under the band. Columns whose top
       isn't sky (tree tips, temple roof) take the mean tone so the band never streaks. */
    var seam = new Float32Array(FW * 3);
    for (var xx = 0; xx < FW; xx++) {
      var sr = 0, sg = 0, sb = 0, m = 0;
      for (var yy = BAND; yy < BAND + 6 && yy < FH; yy++) {
        var ii = (yy * FW + xx) * 4; sr += p[ii]; sg += p[ii + 1]; sb += p[ii + 2]; m++;
      }
      sr /= m; sg /= m; sb /= m;
      if (!(sb > sr + 20)) { sr = mr; sg = mg; sb = mb; }
      seam[xx * 3] = sr; seam[xx * 3 + 1] = sg; seam[xx * 3 + 2] = sb;
    }
    /* deeper, bluer sky at the very top easing into each column's seam color */
    for (var y = 0; y < BAND; y++) {
      var t = y / BAND, e = t * t * (3 - 2 * t);
      for (var x2 = 0; x2 < FW; x2++) {
        var s0 = seam[x2 * 3], s1 = seam[x2 * 3 + 1], s2 = seam[x2 * 3 + 2];
        var tr = s0 * .68, tg = s1 * .80, tb = s2 * .96;
        var i2 = (y * FW + x2) * 4;
        p[i2] = tr + (s0 - tr) * e;
        p[i2 + 1] = tg + (s1 - tg) * e;
        p[i2 + 2] = tb + (s2 - tb) * e;
        p[i2 + 3] = 255;
      }
    }

    SCROLL = { x0: SCROLL_UV.x0, x1: SCROLL_UV.x1,
               y0: (BAND + SCROLL_UV.y0 * HP) / FH, y1: (BAND + SCROLL_UV.y1 * HP) / FH };
    return p;
  }

  var img = new Image();
  img.onload = function () {
    var src, sea, sky, scr;
    try {
      src = composeSource(img);
      sea = new Uint8Array(FW * FH); sky = new Uint8Array(FW * FH); scr = new Uint8Array(FW * FH);
      var sx0 = SCROLL.x0 * FW, sx1 = SCROLL.x1 * FW, sy0 = SCROLL.y0 * FH, sy1 = SCROLL.y1 * FH;
      for (var y = 0; y < FH; y++) for (var x = 0; x < FW; x++) {
        var i = (y * FW + x) * 4, R = src[i], G = src[i + 1], B2 = src[i + 2];
        var L = R * .299 + G * .587 + B2 * .114;
        /* color-exclusive masks — no vertical ranges, so any recompose keeps working.
           Sky is bluer than green (B>G); the bay is turquoise (G≈B, both ≫ R). */
        if (B2 > G + 12 && B2 > R + 40 && L > 120) sky[y * FW + x] = 1;
        else if (Math.abs(B2 - G) <= 14 && G > R + 40 && L > 60) sea[y * FW + x] = 1;
        /* pale-paper gate: robe and marble inside the rect stay still */
        if (x > sx0 && x < sx1 && y > sy0 && y < sy1 && L > 135) {
          var fx = Math.min(x - sx0, sx1 - x) / ((sx1 - sx0) * .5),
              fy = Math.min(y - sy0, sy1 - y) / ((sy1 - sy0) * .5);
          scr[y * FW + x] = Math.max(0, Math.min(255, Math.min(fx, fy) * 3 * 255)) | 0;
        }
      }
    } catch (e) { plate.classList.add('is-fallback'); return; }

    cv.width = FW; cv.height = FH;
    var out = ctx.createImageData(FW, FH), o = out.data;
    var t0 = performance.now(), last = 0, lastTick = 0, running = true;
    window.__hero = { frames: 0, step: function (ms) { step(ms); }, scroll: SCROLL, FW: FW, FH: FH };

    function nearest(r, g, b) {
      var bi = 0, bd = 1e9;
      for (var i = 0; i < PAL.length; i++) {
        var dr = r - PAL[i][0], dg = g - PAL[i][1], db = b - PAL[i][2], d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; bi = i; }
      }
      return PAL[bi];
    }
    function hash(x, y, s) { var h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return h - Math.floor(h); }

    function step(now) {
      lastTick = now;
      if (now - last < 33) return; last = now;
      window.__hero.frames++;
      var dev = reduced ? 1 : Math.min(1, (now - t0) / 1900);   /* the dither develops in */
      var t = reduced ? 0.33 : ((now - t0) % LOOP) / LOOP;
      var epoch = Math.floor(t * 30);
      for (var y = 0; y < FH; y++) {
        for (var x = 0; x < FW; x++) {
          var idx = y * FW + x, sx = x, sy = y, d = 0, f = scr[idx];
          if (!reduced) {
            if (f > 0) {                                         /* the scroll flutters */
              sx = x + Math.round(2.2 * (f / 255) * Math.sin(TAU * (t * 3) + y * .30));
              d += 6 * (f / 255) * Math.sin(TAU * (t * 2) + 1.3);
            }
            if (sea[idx]) {
              d += 14 * Math.sin(TAU * (t * 6) + x * .5 + y * 2.2);
              if (hash(x, y, epoch) > .9988) d += 70;             /* rare sun glint */
            }
            if (sky[idx]) {
              var bx = ((x / FW - t) % 1 + 1) % 1, bd2 = Math.min(bx, 1 - bx);
              d += Math.max(0, 1 - bd2 * 6) * 10;                 /* cloud light drifts */
            }
          }
          if (sx < 0) sx = 0; if (sx >= FW) sx = FW - 1;
          if (sy < 0) sy = 0; if (sy >= FH) sy = FH - 1;
          var s = (sy * FW + sx) * 4;
          var bay = (B[y & 7][x & 7] / 64 - .5) * 46;
          var c = (x / FW > dev * 1.12) ? PAL[3] : nearest(src[s] + bay + d, src[s + 1] + bay + d, src[s + 2] + bay + d);
          o[idx * 4] = c[0]; o[idx * 4 + 1] = c[1]; o[idx * 4 + 2] = c[2]; o[idx * 4 + 3] = 255;
        }
      }
      ctx.putImageData(out, 0, 0);
    }

    function frame(now) {
      if (!running) return;
      requestAnimationFrame(frame);
      if (!reduced) step(now);
    }
    /* watchdog: some embedded panes starve rAF — keep the loop alive there */
    setInterval(function () {
      var now = performance.now();
      if (running && !reduced && !document.hidden && now - lastTick > 600) step(now);
    }, 400);

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (en) {
        var vis = en[0].isIntersecting;
        if (vis && !running && !reduced) { running = true; requestAnimationFrame(frame); }
        if (!vis) running = false;
      }).observe(cv);
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) running = false;
      else if (!running && !reduced) { running = true; requestAnimationFrame(frame); }
    });
    if (reduced) step(t0 + 5000); else requestAnimationFrame(frame);
  };
  img.onerror = function () { plate.classList.add('is-fallback'); };
  img.src = SRC;
})();

/* The living terminal + installer tabs. One selection drives both: pick a
   way in and the terminal plays that session, abridged. Untouched, it tours
   both; the first click ends the tour. The install session is an abridged
   run of assets/install.mjs on a test setup; every figure in both sessions —
   the data date, prices, usage shares, the quoted doc line, which two models
   the MCP session compares — is read from data/models.json and
   data/guidance.json when the page loads. If they don't load, figures show
   as "—" rather than a number we can't back. No model is chosen for anyone:
   each helper's model is the user's own choice, the tool's own documented
   default (quoted), or the same as the main model. */
(function () {
  "use strict";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var NA = "—";

  function esc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function money(v) { return typeof v === "number" ? "$" + (v % 1 === 0 ? String(v) : v.toFixed(2)) : NA; }
  function priceText(m) { return m ? money(m.price_input) + " / " + money(m.price_output) : NA + " / " + NA; }
  function shareOf(m) { var u = m && m.usage && m.usage.openrouter; return u && typeof u.share === "number" ? u : null; }
  function releasedKey(v) {
    var s = String(v || "");
    if (/^\d{4}(-\d{2}){0,2}$/.test(s)) return s;
    var q = /^(\d{4})-Q([1-4])$/.exec(s);
    return q ? q[1] + "-" + String((q[2] - 1) * 3 + 1).padStart(2, "0") : "";
  }
  function labQuotes(m) {
    var n = 0, seen = {};
    Object.keys((m && m.task_fit_judged) || {}).forEach(function (k) {
      ((m.task_fit_judged[k] || {}).claims || []).forEach(function (c) {
        if (c && c.tier === "lab" && c.quote && !seen[c.quote]) { seen[c.quote] = 1; n++; }
      });
    });
    return n;
  }

  /* The facts the two sessions print, from the data files (F empty -> every figure is "—").
     builder: the model Claude Code's "opus" alias resolves to (guidance model_refs).
     bulk:    Claude Code's bulk helper model (guidance tool_plans), as the alias its files take
              (model_refs), and the tool's own quote behind it. Scout, builder and reviewer
              inherit the lead's model, the same rule the package uses.
     pair:    the builder's model plus the newest generally available, priced model with an
              OpenRouter usage row from another lab — a rule over the data, not a judgment. */
  function factsFrom(modelsFile, guidance) {
    var models = (modelsFile && modelsFile.models) || [];
    var byId = {};
    models.forEach(function (m) { byId[m.id] = m; });
    var g = guidance || {};
    var ref = (g.model_refs || []).filter(function (r) { return r.tool === "claude-code" && r.ref === "opus"; })[0];
    var builder = ref ? byId[ref.model_id] || null : null;
    var plan = (g.tool_plans || []).filter(function (t) { return t.tool === "claude-code"; })[0] || null;
    var bulk = plan && plan.bulk && plan.bulk.model_id ? plan.bulk : null;
    var bulkRef = bulk ? (g.model_refs || []).filter(function (r) { return r.tool === "claude-code" && r.model_id === bulk.model_id; })[0] || null : null;
    var claims = {};
    (g.claims || []).forEach(function (c) { claims[c.id] = c; });
    var quote = null;
    if (bulkRef) (bulk.basis || []).some(function (id) { var c = claims[id]; if (c && c.quote && c.tier === "tool") { quote = c; return true; } return false; });
    var other = models.filter(function (m) {
      return m.status === "ga" && typeof m.price_output === "number" && shareOf(m) && releasedKey(m.released) &&
        (!builder || m.vendor !== builder.vendor);
    }).sort(function (a, b) { return releasedKey(b.released).localeCompare(releasedKey(a.released)) || a.name.localeCompare(b.name); })[0] || null;
    var pair = [builder, other].filter(Boolean);
    var usageAsOf = pair.map(function (m) { return shareOf(m) ? shareOf(m).as_of : ""; }).filter(Boolean).sort().pop() || null;
    return { asOf: (modelsFile && modelsFile.as_of) || null, builder: builder, bulkRef: bulkRef ? bulkRef.ref : null,
             quote: quote, pair: pair, usageAsOf: usageAsOf };
  }

  function buildScripts(F) {
    F = F || {};
    var pair = F.pair || [];
    var a = pair[0] || null, b = pair[1] || null;
    var nameA = a ? a.name : NA, nameB = b ? b.name : NA;
    function compareLine(m) {
      if (!m) return '<span class="hi">' + NA + '</span>';
      var u = shareOf(m);
      return '<span class="hi">' + esc(m.name) + '</span> · <span class="y">' + priceText(m) + '</span> per 1M · ' +
        (u ? u.share + "% of OpenRouter tokens" : "no OpenRouter usage row");
    }
    var qa = labQuotes(a), qb = labQuotes(b);
    var quotesLine = (!a || !b) ? 'Lab quotes on file: ' + NA
      : (!qa && !qb) ? 'Lab quotes on file: none yet for either <span class="dim">— left blank, not guessed</span>'
      : 'Lab quotes on file: ' + qa + ' for ' + esc(nameA) + ' · ' + qb + ' for ' + esc(nameB);
    var bulkLine = F.bulkRef && F.quote
      ? 'bulk → <span class="ok">' + esc(F.bulkRef) + '</span> · Claude Code docs: &ldquo;' + esc(F.quote.quote) + ' &hellip;&rdquo;'
      : 'bulk → the same model as your main one';
    return {
      prompt: {
        title: "claude — 96×28",
        lines: [
          { t: "banner", html: '<b>✻</b> Welcome to <b>Claude Code</b>! <span class="dim">/help for help · cwd: ~/work/app</span>' },
          { t: "you", html: '<span class="dim">[Pasted text #1 · the Modelproof install prompt]</span>' },
          { t: "tool", html: 'Modelproof: set which model each helper runs in your Claude Code, for every project. <span class="hi">Right?</span>' },
          { t: "you", type: true, html: "yes" },
          { t: "tool", html: 'Bash(node install.mjs detect) <span class="dim">· Claude Code · 2 helpers with no model set · 1 rule mentions opus</span>' },
          { t: "ask", html: '3 quick questions. How often do you hit your plan&rsquo;s limits?<br><span class="opt">❯ 1. Often</span> &nbsp; 2. Sometimes &nbsp; 3. Rarely' },
          { t: "you", type: true, html: "often · coding and agents · keep opus for builds, like my rule says" },
          { t: "tool", html: 'Bash(node install.mjs plan) <span class="dim">· facts as of ' + esc(F.asOf || NA) + '</span>' },
          { t: "sub", html: 'scout · reviewer → the same model as your main one' },
          { t: "sub", html: 'builder → <span class="ok">opus</span> · your choice · <span class="y">' + priceText(F.builder) + '</span> per 1M' },
          { t: "sub", html: bulkLine },
          { t: "sub", html: '5 new files · your CLAUDE.md is not touched' },
          { t: "ask", html: 'Go?<br><span class="opt">❯ 1. Yes</span> &nbsp; 2. Yes, but no to #4 &nbsp; 3. No' },
          { t: "tool", html: 'Bash(node install.mjs apply) <span class="ok">✓</span> added <span class="y">agents/modelproof-scout.md</span> · builder · reviewer · bulk · <span class="y">rules/modelproof.md</span>' },
          { t: "out", html: 'Undo any time: <span class="ok">node ~/.modelproof/bin/install.mjs undo fd1d9c01d992</span>' }
        ]
      },
      mcp: {
        title: "zsh — 96×28",
        lines: [
          { t: "sh", type: true, html: "claude mcp add modelproof -- node mcp/server.js" },
          { t: "out", html: '<span class="ok">✓</span> modelproof is now a tool in every session' },
          { t: "sh", type: true, html: "claude" },
          { t: "you", type: true, html: esc("what do " + nameA.toLowerCase() + " and " + nameB.toLowerCase() + " cost, and what do their labs say about them?") },
          { t: "tool", html: 'modelproof.compare_models(names: [&ldquo;' + esc(nameA.toLowerCase()) + '&rdquo;, &ldquo;' + esc(nameB.toLowerCase()) + '&rdquo;]) <span class="dim">· data as of ' + esc(F.asOf || NA) + '</span>' },
          { t: "sub", html: compareLine(a) },
          { t: "sub", html: compareLine(b) },
          { t: "sub", html: quotesLine },
          { t: "out", html: 'Prices from each lab&rsquo;s own pricing page; usage from OpenRouter (' + esc(F.usageAsOf || NA) + ').' }
        ]
      }
    };
  }
  var SCRIPTS = buildScripts(null);
  var ORDER = ["prompt", "mcp"];

  var body = document.getElementById("termBody");
  var title = document.getElementById("termTitle");
  var dotsWrap = document.getElementById("termDots");
  if (!body || !title || !dotsWrap) return;
  var dots = dotsWrap.children;
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".inst-tab"));
  var panes = Array.prototype.slice.call(document.querySelectorAll(".inst-pane"));

  var current = "prompt", timers = [], userDrove = false;
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function follow() { body.scrollTop = body.scrollHeight; }

  function typeLine(el, text, done) {
    if (reduced) { el.textContent = text; el.classList.add("show"); done(); return; }
    var caret = document.createElement("span");
    caret.className = "tcaret";
    el.classList.add("show");
    el.appendChild(caret);
    var i = 0;
    (function tick() {
      if (i <= text.length) {
        el.textContent = text.slice(0, i);
        el.appendChild(caret);
        i++;
        timers.push(setTimeout(tick, 18 + Math.random() * 26));
      } else {
        later(function () { if (caret.parentNode) caret.parentNode.removeChild(caret); done(); }, 260);
      }
    })();
  }

  function play(method) {
    clearTimers();
    var script = SCRIPTS[method];
    body.innerHTML = "";
    body.scrollTop = 0;
    title.textContent = script.title;
    for (var d = 0; d < dots.length; d++) dots[d].classList.toggle("on", ORDER[d] === method);
    var els = script.lines.map(function (l) {
      var div = document.createElement("div");
      div.className = "tln " + l.t;
      body.appendChild(div);
      return div;
    });
    if (reduced) {
      script.lines.forEach(function (l, i) { els[i].innerHTML = l.html; els[i].classList.add("show"); });
      follow(); scheduleNext(9000); return;
    }
    var i = 0;
    (function next() {
      if (i >= script.lines.length) { scheduleNext(4800); return; }
      var l = script.lines[i], el = els[i];
      i++;
      if (l.type) {
        var tmp = document.createElement("div"); tmp.innerHTML = l.html;
        later(function () { typeLine(el, tmp.textContent, function () { follow(); later(next, 300); }); }, 350);
      } else {
        later(function () { el.innerHTML = l.html; el.classList.add("show"); follow(); later(next, 820); }, 350);
      }
    })();
  }

  function scheduleNext(ms) {
    if (userDrove) return;
    later(function () { setMethod(ORDER[(ORDER.indexOf(current) + 1) % ORDER.length], false); }, ms);
  }

  function setMethod(method, fromUser) {
    if (fromUser) userDrove = true;
    var prev = current; current = method;
    tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t.dataset.m === method)); });
    var fwd = ORDER.indexOf(method) >= ORDER.indexOf(prev);
    panes.forEach(function (p) {
      var on = p.dataset.pane === method;
      p.classList.remove("from-l", "from-r");
      if (on && fromUser) p.classList.add(fwd ? "from-r" : "from-l");
      p.classList.toggle("on", on);
      if (on) p.removeAttribute("hidden"); else p.setAttribute("hidden", "");
    });
    if (reduced) { play(method); return; }
    var dir = fwd ? "l" : "r";
    body.classList.add("swap-" + dir);
    clearTimers();
    later(function () {
      body.classList.remove("swap-l", "swap-r");
      body.classList.add("swap-" + (dir === "l" ? "r" : "l"));
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        body.classList.remove("swap-l", "swap-r"); play(method);
      }); });
    }, 310);
  }
  tabs.forEach(function (t) { t.addEventListener("click", function () { setMethod(t.dataset.m, true); }); });

  // the paste-in prompt: one copy of the text, in assets/install-prompt.txt, shared with the
  // board and skills/README.md. The textarea keeps its short fallback if the file can't load.
  var promptEl = document.getElementById("promptText");
  if (promptEl && window.fetch) {
    fetch(promptEl.getAttribute("data-src") || "assets/install-prompt.txt", { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then(function (text) { if (text.trim()) { promptEl.value = text.trim(); promptEl.classList.add("loaded"); } })
      .catch(function () { /* keep the fallback line */ });
  }
  function copyText(text, btn) {
    var done = function () { btn.classList.add("did"); setTimeout(function () { btn.classList.remove("did"); }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
  }
  var cp = document.getElementById("copyPrompt");
  if (cp && promptEl) cp.addEventListener("click", function () { copyText(promptEl.value, cp); });
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (b) {
    b.addEventListener("click", function () { copyText(b.getAttribute("data-copy"), b); });
  });

  // Figures first, then the show: the terminal starts once the data is in (or has failed, in
  // which case every figure reads "—").
  function getJson(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
  }
  var started = false;
  function start(F) { if (started) return; started = true; SCRIPTS = buildScripts(F); play(current); }
  if (window.fetch) {
    Promise.all([getJson("data/models.json"), getJson("data/guidance.json")])
      .then(function (files) { start(factsFrom(files[0], files[1])); })
      .catch(function () { start(null); });
  } else {
    start(null);
  }
})();

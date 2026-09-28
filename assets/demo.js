/* The living terminal + installer tabs. One selection drives both: pick a
   way in and the terminal plays that session, abridged. Untouched, it tours
   both; the first click ends the tour. The install session is an abridged
   real run of assets/install.mjs on the cc-max5x test setup (2026-09-27);
   the MCP session uses the live data's own figures. No model is chosen for
   anyone: each helper's model is the user's own choice, the tool's own
   documented default (quoted), or the same as the main model. */
(function () {
  "use strict";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var SCRIPTS = {
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
        { t: "tool", html: 'Bash(node install.mjs plan) <span class="dim">· facts as of 2026-09-27</span>' },
        { t: "sub", html: 'scout → <span class="ok">haiku</span> · Claude Code docs: &ldquo;For simple subagent tasks, specify model: haiku &hellip;&rdquo;' },
        { t: "sub", html: 'builder → <span class="ok">opus</span> · your choice · <span class="y">$4 / $20</span> per 1M' },
        { t: "sub", html: 'reviewer → the same model as your main one' },
        { t: "sub", html: '5 new files · your CLAUDE.md is not touched' },
        { t: "ask", html: 'Go?<br><span class="opt">❯ 1. Yes</span> &nbsp; 2. Yes, but no to #4 &nbsp; 3. No' },
        { t: "tool", html: 'Bash(node install.mjs apply) <span class="ok">✓</span> added <span class="y">agents/modelproof-scout.md</span> · builder · reviewer · explore · <span class="y">rules/modelproof.md</span>' },
        { t: "out", html: 'Undo any time: <span class="ok">node ~/.modelproof/bin/install.mjs undo fd1d9c01d992</span>' }
      ]
    },
    mcp: {
      title: "zsh — 96×28",
      lines: [
        { t: "sh", type: true, html: "claude mcp add modelproof -- node mcp/server.js" },
        { t: "out", html: '<span class="ok">✓</span> modelproof is now a tool in every session' },
        { t: "sh", type: true, html: "claude" },
        { t: "you", type: true, html: "what do claude opus 5.5 and gpt-6 sol cost, and what do their labs say about them?" },
        { t: "tool", html: 'modelproof.compare_models(names: [&ldquo;opus 5.5&rdquo;, &ldquo;gpt-6 sol&rdquo;]) <span class="dim">· data as of 2026-09-27</span>' },
        { t: "sub", html: '<span class="hi">Claude Opus 5.5</span> · <span class="y">$4 / $20</span> per 1M · 0.49% of OpenRouter tokens' },
        { t: "sub", html: '<span class="hi">GPT-6 Sol</span> · <span class="y">$2 / $10</span> per 1M · 0.37% of OpenRouter tokens' },
        { t: "sub", html: 'Lab quotes on file: none yet for either <span class="dim">— left blank, not guessed</span>' },
        { t: "out", html: 'Prices from each lab&rsquo;s own pricing page; usage from OpenRouter (2026-09-25).' }
      ]
    }
  };
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

  play(current);
})();

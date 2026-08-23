/* The living terminal + installer tabs. One selection drives both: pick a
   way in and the terminal plays that session, abridged. Untouched, it tours
   all three; the first click ends the tour. Every session is a shortened
   version of a real dry-run of the skill (2026-08-22) — nothing here claims
   a number the live data doesn't carry. */
(function () {
  "use strict";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var SCRIPTS = {
    prompt: {
      title: "claude — 96×28",
      lines: [
        { t: "banner", html: '<b>✻</b> Welcome to <b>Claude Code</b>! <span class="dim">/help for help · cwd: ~/work/reviews</span>' },
        { t: "you", type: true, html: "im boutta do an overnight bulk — summarize 30k customer reviews into one-line takeaways. what should i use" },
        { t: "tool", html: 'Modelproof: you\'re summarizing ~30k reviews overnight, Claude is what you have, cheap wins if it holds up. <span class="hi">Right?</span>' },
        { t: "you", type: true, html: "yes" },
        { t: "tool", html: 'Read(<span class="y">models.json</span> · snapshot 2026-08-21) <span class="dim">· ranked 49 models for bulk</span>' },
        { t: "sub", html: 'Use <span class="ok">Claude Haiku 4.5</span>, thinking off — <span class="y">$1 / $5</span> per 1M, clears the floor for extraction' },
        { t: "sub", html: 'Use it well: format rules in the system prompt once (cached) · Batch API for the overnight discount · run 500 first' },
        { t: "sub", html: 'Outside your kit: <span class="hi">Gemini Flash-Lite</span> at $0.10 / $0.40 — a tenth of the price, thinner docs. Your call.' },
        { t: "ask", html: 'Nothing to write for a one-off script — use model id <span class="ok">claude-haiku-4-5</span>. Want it as this project\'s default too?<br><span class="opt">❯ 1. Yes, set it</span> &nbsp; 2. No, I\'m set' }
      ]
    },
    cli: {
      title: "zsh — 96×28",
      lines: [
        { t: "sh", type: true, html: "for f in SKILL.md references/…; do curl -fsSL --create-dirs …/modelproof-advisor/$f -o ~/.claude/skills/modelproof-advisor/$f; done" },
        { t: "out", html: '<span class="ok">✓</span> SKILL.md · data.md · detect-setup.md · consent.md · security.md <span class="dim">— 5 files, nothing piped to a shell</span>' },
        { t: "sh", type: true, html: "claude" },
        { t: "banner", html: '<b>✻</b> Welcome to <b>Claude Code</b>! <span class="dim">skill loaded: modelproof-advisor</span>' },
        { t: "you", type: true, html: "im boutta create a PE presentation for a client, what should I use" },
        { t: "tool", html: 'Modelproof: a client deck, so quality over price; you\'re in Claude Code, so Claude is what you have. <span class="hi">Right?</span>' },
        { t: "you", type: true, html: "yes" },
        { t: "sub", html: 'Use <span class="ok">Claude Opus 4.8</span> — <span class="y">$5 / $25</span> per 1M, the Claude model tagged for writing <span class="dim">(no benchmark tracks deck quality — said plainly)</span>' },
        { t: "sub", html: 'Use it well: whole brief + sources in one message, let it draft end to end · stable brief first so caching cuts repeat cost' },
        { t: "sub", html: 'Outside your kit: <span class="hi">GPT-5.6 Terra</span> at $2 / $12, close on quality. A fact, your call.' },
        { t: "out", html: 'Nothing to change on disk — pick Opus 4.8 for this session with <span class="ok">/model</span>.' }
      ]
    },
    mcp: {
      title: "zsh — 96×28",
      lines: [
        { t: "sh", type: true, html: "claude mcp add modelproof -- node mcp/server.js" },
        { t: "out", html: '<span class="ok">✓</span> modelproof is now a tool in every session' },
        { t: "sh", type: true, html: "claude" },
        { t: "you", type: true, html: "starting a new agent project this week — what should it run on, budget's mid" },
        { t: "tool", html: 'modelproof.recommend(task: agentic, budget: value) <span class="dim">· snapshot 2026-08-21</span>' },
        { t: "sub", html: '<span class="ok">Claude Opus 5</span> at <span class="y">medium</span> effort — the ladder shows medium within ~8 points of max at half the cost per task' },
        { t: "sub", html: 'Outside your kit: <span class="hi">GPT-5.6 Sol</span> is cheaper per attempt at high effort, lower score. Your call.' },
        { t: "ask", html: 'Plan: set <span class="y">.claude/settings.json</span> → model: claude-opus-5. Backup first. Go?<br><span class="opt">❯ 1. Yes</span> &nbsp; 2. No' },
        { t: "tool", html: 'Edit(.claude/settings.json) <span class="dim">· 1 line · backup at ~/.claude/modelproof-backups/2026-08-22/</span> &nbsp; <span class="ok">✓</span> You\'re all set.' }
      ]
    }
  };
  var ORDER = ["prompt", "cli", "mcp"];

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

  // the paste prompt: installs the skill and starts a session. No internal language.
  var RAW = "https://raw.githubusercontent.com/lucascashwell3-ai/modelproof/main/skills/modelproof-advisor/";
  var promptEl = document.getElementById("promptText");
  if (promptEl) promptEl.value =
    "Install the Modelproof advisor and run it. Download these five files into ~/.claude/skills/modelproof-advisor/ " +
    "(keep the paths): SKILL.md, references/data.md, references/detect-setup.md, references/consent.md, references/security.md " +
    "from " + RAW + " — read them; don't pipe anything into a shell. Then follow SKILL.md and ask me what I'm about to do.";
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

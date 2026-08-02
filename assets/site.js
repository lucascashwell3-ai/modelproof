/* Small page behaviors that belong to the terrace look, kept out of app.js:
   the hero's self-typing install command, the three-door install tabs, and the
   copy buttons. No dependencies, no data — app.js owns everything data-driven. */
(function () {
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- hero command: types itself, click to copy ---- */
  var CMD = 'npx skills add lucascashwell3-ai/modelproof';
  var cmdBtn = document.getElementById('heroCmd');
  var cmdTxt = document.getElementById('heroCmdText');
  var cmdCopy = document.getElementById('heroCmdCopy');
  if (cmdBtn && cmdTxt) {
    if (reduced) { cmdTxt.textContent = CMD; }
    else {
      var i = 0;
      var t = setInterval(function () {
        i++;
        cmdTxt.textContent = CMD.slice(0, i);
        if (i >= CMD.length) clearInterval(t);
      }, 34);
    }
    cmdBtn.addEventListener('click', function () {
      var done = function () {
        if (!cmdCopy) return;
        cmdCopy.textContent = 'copied ✓';
        setTimeout(function () { cmdCopy.textContent = 'copy'; }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(CMD).then(done).catch(done);
      } else done();
    });
  }

  /* ---- three doors in: tabs cycle on their own until the user touches them ---- */
  var doors = document.getElementById('doors');
  if (doors) {
    var tabs = [].slice.call(doors.querySelectorAll('.doors__tab'));
    var panes = [].slice.call(doors.querySelectorAll('.door'));
    var idx = 0, timer = null, touched = false;

    function show(k) {
      idx = k;
      tabs.forEach(function (b, j) {
        b.classList.toggle('is-on', j === k);
        b.setAttribute('aria-selected', j === k ? 'true' : 'false');
      });
      panes.forEach(function (p, j) {
        p.classList.toggle('is-on', j === k);
        if (j === k) p.removeAttribute('hidden'); else p.setAttribute('hidden', '');
      });
    }
    tabs.forEach(function (b, j) {
      b.addEventListener('click', function () {
        touched = true;
        if (timer) { clearInterval(timer); timer = null; }
        show(j);
      });
    });
    /* auto-cycle only while the section is on screen, never after a click,
       never under reduced motion */
    if (!reduced && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        var vis = es[0].isIntersecting;
        if (vis && !touched && !timer) {
          timer = setInterval(function () { show((idx + 1) % panes.length); }, 3400);
        }
        if (!vis && timer) { clearInterval(timer); timer = null; }
      }, { threshold: 0.4 }).observe(doors);
    }
  }

  /* ---- copy buttons on the door commands ---- */
  [].slice.call(document.querySelectorAll('.door__copy')).forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-copy') || '';
      var done = function () {
        b.textContent = 'copied ✓';
        setTimeout(function () { b.textContent = 'copy'; }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(v).then(done).catch(done);
      } else done();
    });
  });
})();

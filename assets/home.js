import { getFacts, readState, wireNav, fillStamps, initShell, $, esc, copyText } from './site-core.js';
import { createBoard } from './setup-board.js';
import { loadAudiences, promptBlock } from './audiences.mjs';

initShell();
const boardEl = $('#board');
const btn = $('#install-btn'), note = $('#install-state'), box = $('#install-prompt');

let facts;
try { facts = await getFacts({ changelog: false }); await loadAudiences(facts); }
catch (err) {
  boardEl.innerHTML = `<p class="noscript">The model data did not load (${esc(err.message)}). Reload to try again.</p>`;
  note.textContent = 'Install needs the model data. Reload to try again.';
  throw err;
}

const state = readState(facts);
wireNav(state);
fillStamps(facts);
const board = createBoard(boardEl, { facts, state });

/* the install prompt: the shipped prompt, plus the board as the installer's own profile when it goes past the defaults */
const promptFor = (s, setup) => facts.installPrompt.trim() + promptBlock(setup, s, facts);
const toolName = (s, setup) => (s.tool === 'any' ? 'your agent' : setup.toolLabel);
let copied = false, prompt = facts.installPrompt.trim(), timer = 0;
board.on(({ state: s, setup }) => {
  wireNav(s);
  const next = promptFor(s, setup);
  // A change after copying makes the copied prompt out of date: say so, and show the new one.
  if (copied && next !== prompt) { copied = false; btn.textContent = 'Install'; clearTimeout(timer); }
  prompt = next;
  $('#prompt-pre').textContent = prompt;
  const none = setup.count && setup.count.fit === 0;
  btn.disabled = none;
  if (!copied) note.textContent = none ? 'No model fits your limits. Turn a lab back on to install.' : `One prompt. Paste it into ${toolName(s, setup)}.`;
});

/* one Install action: copies the one prompt, then shows it. It works only once the data is in. */
btn.addEventListener('click', async () => {
  const ok = await copyText(prompt);
  copied = true;
  box.hidden = false;
  btn.textContent = ok ? 'Copied' : 'Install';
  note.textContent = ok ? `Paste it into ${toolName(board.state, board.setup)}.` : 'Select the text below and copy it.';
  clearTimeout(timer); timer = setTimeout(() => { btn.textContent = 'Install'; }, 2400);
});

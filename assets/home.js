import { getFacts, readState, wireNav, fillStamps, initShell, $, esc, copyText } from './site-core.js';
import { createBoard } from './setup-board.js';

initShell();
const boardEl = $('#board');

let facts;
try { facts = await getFacts(); }
catch (err) {
  boardEl.innerHTML = `<p class="noscript">The model data did not load (${esc(err.message)}). Reload to try again.</p>`;
  throw err;
}

const state = readState(facts);
wireNav(state);
fillStamps(facts);
const board = createBoard(boardEl, { facts, state });
let copied = false;
board.on(({ state: s, setup }) => { wireNav(s); if (!copied) $('#install-state').textContent = `One prompt. Paste it into ${setup.toolLabel}.`; });

/* one Install action: copies the one prompt, then shows it */
const btn = $('#install-btn'), note = $('#install-state'), box = $('#install-prompt');
$('#prompt-pre').textContent = facts.installPrompt.trim();
let timer = 0;
btn.addEventListener('click', async () => {
  const ok = await copyText(facts.installPrompt.trim());
  const tool = board.setup.toolLabel; copied = true;
  box.hidden = false;
  btn.textContent = ok ? 'Copied' : 'Install';
  note.textContent = ok ? `Paste it into ${tool}.` : 'Select the text below and copy it.';
  clearTimeout(timer); timer = setTimeout(() => { btn.textContent = 'Install'; }, 2400);
});

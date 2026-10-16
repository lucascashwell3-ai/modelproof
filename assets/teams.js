import { initShell, getFacts, fillStamps } from './site-core.js';
initShell();
getFacts().then(fillStamps).catch(() => {});

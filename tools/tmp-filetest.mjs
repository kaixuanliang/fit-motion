import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, args: ['--no-sandbox','--disable-gpu'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('file:///D:/Mine/fit-motion/dist/index.html', { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 1200));
const result = await page.evaluate(async () => {
  const out = { idb: 'unknown', subtle: !!globalThis.crypto?.subtle, store: '' };
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('probe', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
    out.idb = 'ok:' + db.name;
  } catch (e) { out.idb = 'fail:' + e.name + ':' + e.message; }
  const sum = document.getElementById('records-sum');
  out.store = sum ? sum.textContent : 'missing';
  out.view = document.getElementById('app')?.dataset.view;
  return out;
});
console.log(result, 'errors:', errors.slice(0, 3));
await browser.close();

import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));
await page.goto('file:///D:/Mine/fit-motion/dist/index.html', { waitUntil: 'load', timeout: 30000 });
await new Promise((r) => { setTimeout(r, 3000); });
const probe = await page.evaluate(async () => {
  const results = {};
  results.blobWorker = await (async () => {
    try {
      const blob = new Blob(['self.onmessage=e=>self.postMessage(e.data*2)'], { type: 'text/javascript' });
      const w = new Worker(URL.createObjectURL(blob));
      return await new Promise((resolve) => {
        w.onmessage = (ev) => { resolve(ev.data === 42); w.terminate(); };
        w.onerror = () => resolve(false);
        w.postMessage(21);
        setTimeout(() => resolve(false), 2000);
      });
    } catch { return false; }
  })();
  return results;
});
console.log('blob worker 可用:', JSON.stringify(probe));
console.log('控制台错误:', errors.length ? errors.slice(0, 5) : '无');
await browser.close();

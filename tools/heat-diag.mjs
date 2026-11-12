import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => document.querySelector('#record-list .rec, #records-empty'), { timeout: 30000 });
const ringB64 = readFileSync('testdata/beijing-ring6-outside.fit').toString('base64');
await page.evaluate(async (b64) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  await importFiles([new File([decode(b64)], 'beijing-ring6-outside.fit')]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
}, ringB64);
await page.waitForFunction(() => {
  const banner = document.getElementById('yr-banner');
  return banner && !banner.hidden;
}, { timeout: 30000 });
await page.click('#yr-banner');
await page.waitForFunction(() => document.querySelectorAll('#yr-deck .yr-card').length > 0, { timeout: 120000 });
const info = await page.evaluate(() => {
  const svg = document.querySelector('.yr-heat svg');
  const hits = [];
  const walk = (ruleList, ctx) => {
    for (const rule of ruleList) {
      if (rule.selectorText) {
        try {
          if (svg.matches(rule.selectorText) && /stroke|fill/.test(rule.style?.cssText ?? rule.cssText)) {
            hits.push(`${ctx} ${rule.selectorText} { ${rule.style.cssText} }`);
          }
        } catch { }
      }
      if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules, ctx + '/group');
    }
  };
  for (const sheet of document.styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch { continue; }
    walk(list, sheet.ownerNode?.id ?? sheet.ownerNode?.tagName ?? '?');
  }
  return hits;
});
console.log(info.join('\n') || 'none');
await browser.close();

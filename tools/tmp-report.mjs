import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, args: ['--no-sandbox'],
  defaultViewport: { width: 900, height: 1200, deviceScaleFactor: 1.5 },
});
const page = await browser.newPage();
const bad = [];
page.on('requestfailed', (r) => bad.push(r.url()));
await page.goto('file:///D:/Mine/fit-motion/docs/%E4%BD%BF%E7%94%A8%E4%B8%8E%E9%AA%8C%E8%AF%81%E6%8A%A5%E5%91%8A.html', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 600));
const info = await page.evaluate(() => ({
  title: document.title,
  sections: document.querySelectorAll('section').length,
  imgs: [...document.images].map((i) => ({ ok: i.naturalWidth > 0, src: i.src.split('/').slice(-2).join('/'), w: i.naturalWidth })),
  height: document.body.scrollHeight,
}));
console.log(JSON.stringify(info, null, 2));
console.log('failed requests:', bad.length, bad.slice(0, 3));
await page.screenshot({ path: 'screenshots/app/21-report-top.png' });
await browser.close();

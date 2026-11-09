import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, args: ['--no-sandbox'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
const r = await page.evaluate(async () => {
  const out = {};
  out.gridInSettings = !!document.querySelector('#theme-grid');
  out.buttons = [...document.querySelectorAll('#theme-grid [data-set-theme]')].map((b) => b.dataset.setTheme);
  document.querySelector('[data-tab="settings"]')?.click();
  await new Promise((r2) => setTimeout(r2, 300));
  out.visible = !!document.querySelector('#settings-pane.pane.active #theme-grid');
  const before = document.documentElement.dataset.theme;
  const bgBefore = getComputedStyle(document.body).backgroundColor;
  const btn = document.querySelector('#theme-grid [data-set-theme="night"]');
  btn?.click();
  await new Promise((r2) => setTimeout(r2, 400));
  out.afterNight = {
    theme: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
    btnOn: document.querySelector('#theme-grid [data-set-theme="night"]')?.classList.contains('on'),
    stored: localStorage.getItem('fitmotion-theme'),
  };
  out.before = { theme: before, bg: bgBefore };
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();

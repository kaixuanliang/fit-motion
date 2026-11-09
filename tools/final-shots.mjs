import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--disable-crash-reporter', '--disable-breakpad'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});

async function shot(name, url, viewport, wait = 9000) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((resolve) => setTimeout(resolve, wait));
  if (url.includes('demo=1')) {
    try {
      await page.waitForFunction(() => document.getElementById('stage-loading').classList.contains('is-hidden'), { timeout: 180000 });
      await new Promise((resolve) => setTimeout(resolve, 700));
    } catch {
      // Keep the loading screenshot if the network stalled.
    }
  }
  await page.evaluate(() => {
    const play = document.getElementById('big-play');
    if (play) play.style.display = 'none';
    const toast = document.getElementById('toast');
    if (toast) toast.style.display = 'none';
  });
  await page.screenshot({ path: `screenshots/${name}.png` });
  await page.close();
}

await shot('landing', 'http://127.0.0.1:5180/', { width: 1440, height: 1000, deviceScaleFactor: 1 }, 9000);
await shot('cover', 'http://127.0.0.1:5180/?demo=1&theme=bright&t=0.3&still=1', { width: 1440, height: 1000, deviceScaleFactor: 1 }, 10000);
await shot('final-run', 'http://127.0.0.1:5180/?demo=1&theme=bright&t=8&still=1', { width: 1440, height: 1000, deviceScaleFactor: 1 }, 10000);
await shot('final-moment', 'http://127.0.0.1:5180/?demo=1&theme=bright&t=17.8&still=1', { width: 1440, height: 1000, deviceScaleFactor: 1 }, 10000);
await shot('final-drawer', 'http://127.0.0.1:5180/?demo=1&theme=bright&t=27&still=1', { width: 1440, height: 1000, deviceScaleFactor: 1 }, 10000);
await shot('final-result', 'http://127.0.0.1:5180/?demo=1&theme=bright&t=40&still=1', { width: 1440, height: 1000, deviceScaleFactor: 1 }, 10000);
await shot('theme-night', 'http://127.0.0.1:5180/?demo=1&theme=night&t=8&still=1', { width: 1440, height: 1000, deviceScaleFactor: 1 }, 10000);
await shot('theme-night-result', 'http://127.0.0.1:5180/?demo=1&theme=night&t=40&still=1', { width: 1440, height: 1000, deviceScaleFactor: 1 }, 10000);
await shot('theme-tech', 'http://127.0.0.1:5180/?demo=1&theme=tech&t=8&still=1', { width: 1440, height: 1000, deviceScaleFactor: 1 }, 10000);
await shot('theme-tech-result', 'http://127.0.0.1:5180/?demo=1&theme=tech&t=40&still=1', { width: 1440, height: 1000, deviceScaleFactor: 1 }, 10000);
await shot('mobile-final', 'http://127.0.0.1:5180/?demo=1&theme=bright&t=8&still=1', { width: 390, height: 844, deviceScaleFactor: 2 }, 10000);
await shot('mobile-result', 'http://127.0.0.1:5180/?demo=1&theme=bright&t=40&still=1', { width: 390, height: 844, deviceScaleFactor: 2 }, 10000);

await browser.close();
console.log('final screenshots ready');

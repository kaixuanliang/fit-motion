// 构建产物冒烟：以静态服务加载 dist/index.html（外置 defer JS 形态），
// 确认应用能正常启动、无页面错误、主要区域已渲染。
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('dist');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const file = req.url === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
  try {
    const data = fs.readFileSync(path.join(root, file));
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(5199, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500));

const state = await page.evaluate(() => ({
  title: document.title,
  hasApp: !!document.querySelector('.app, #app, main'),
  bodyText: (document.body.innerText || '').slice(0, 60).replace(/\s+/g, ' '),
  scriptTags: [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')),
}));

console.log(JSON.stringify({ ...state, errors: errors.slice(0, 3) }));
const ok = state.hasApp && state.scriptTags.includes('./assets/app.js') && errors.length === 0;
console.log(ok ? 'PASS: built artifact boots with external defer bundle' : 'FAIL');
await browser.close();
server.close();
process.exit(ok ? 0 : 1);

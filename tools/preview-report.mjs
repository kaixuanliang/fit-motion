// Renders the post-export report panel at phone size so its typography and
// line breaks can be checked without installing the APK.
import http from 'node:http';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const html = fs.readFileSync('dist/index.html');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((resolve) => server.listen(5196, '127.0.0.1', resolve));

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--hide-scrollbars'],
  defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5196/', { waitUntil: 'domcontentloaded' });
await new Promise((resolve) => setTimeout(resolve, 1200));

await page.evaluate(() => {
  const $ = (id) => document.getElementById(id);
  $('export-overlay').hidden = false;
  $('export-ring').style.display = 'none';
  $('export-eyebrow').style.display = 'none';
  $('export-progress-box').style.display = 'none';
  $('export-hint').style.display = 'none';
  $('export-title').textContent = '导出完成';
  const report = $('export-report');
  report.hidden = false;
  report.textContent = [
    '编码器  H.264 AVC1 HW',
    '总帧数  900 帧 / 30.0 秒',
    '每帧均摊  177.3 ms',
    '────────────',
    '渲染耗时  36.0 ms/帧',
    '交帧耗时  138.2 ms/帧',
    '编码等待  2.1 ms/帧',
    '封装耗时  120 ms',
    '合计耗时  159.6 秒',
    '保存结果  已保存到手机',
  ].join('\n');
  const button = $('cancel-export');
  button.textContent = '完成';
  button.classList.add('is-done');
});

fs.mkdirSync('.workbuddy/tmp', { recursive: true });
await page.screenshot({ path: '.workbuddy/tmp/export-report.png' });
await browser.close();
server.close();
console.log('saved .workbuddy/tmp/export-report.png');

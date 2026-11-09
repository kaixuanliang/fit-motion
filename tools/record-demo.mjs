/**
 * FitMotion 操作演示视频录制（webm → mp4，带真实背景音乐）。
 *
 * 镜头顺序（对应 docs/使用与验证报告.html）：
 * 片头 → ① 首页 → ② 导入 FIT → ③ 创作页 → ④ 播放 → ⑤ 换音乐
 * → ⑥ 全屏 → ⑦ 设置 → ⑧ 备份 → 片尾
 *
 * 依赖：puppeteer-core + ffmpeg（node_modules/ffmpeg-static/ffmpeg.exe 已在 PATH）
 * 运行：PATH="$PWD/node_modules/ffmpeg-static:$PATH" node tools/record-demo.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const WEBM = 'docs/fitmotion-demo.webm';
const WAV = 'docs/_demo-bed.wav';
const MP4 = 'docs/FitMotion-操作演示.mp4';
const VP = { width: 430, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FF = 'ffmpeg';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: VP,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// ---- 注入：字幕胶囊 + 点击波纹 + 片头片尾卡 -------------------------------
async function injectHelpers() {
  await page.evaluate(() => {
    const css = document.createElement('style');
    css.textContent = `
      #demo-caption{position:fixed;left:50%;top:92px;transform:translate(-50%,-6px);z-index:99999;
        max-width:362px;box-sizing:border-box;
        background:rgba(18,20,26,.86);color:#fff;border:1px solid rgba(255,255,255,.14);
        border-radius:999px;padding:9px 16px;text-align:center;
        font:600 12.5px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
        box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:none;opacity:0;
        transition:opacity .35s ease,transform .35s ease}
      #demo-caption.show{opacity:1;transform:translate(-50%,0)}
      .demo-ripple{position:fixed;z-index:99998;width:46px;height:46px;margin:-23px 0 0 -23px;
        border-radius:50%;border:3px solid #ffd54a;pointer-events:none;
        box-shadow:0 0 0 2px rgba(0,0,0,.18);animation:demo-rip .75s ease-out forwards}
      @keyframes demo-rip{0%{transform:scale(.35);opacity:1}100%{transform:scale(1.55);opacity:0}}
      #demo-card{position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;
        align-items:center;justify-content:center;gap:14px;color:#fff;
        background:radial-gradient(120% 80% at 50% 0%,#2c3a2a,#0f1310 70%);
        font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
        transition:opacity .5s ease}
      #demo-card.hide{opacity:0;pointer-events:none}
      #demo-card .logo{width:78px;height:78px;border-radius:24px;display:flex;align-items:center;
        justify-content:center;background:linear-gradient(145deg,#7fbf3f,#4c8a1e);
        font:800 34px/1 -apple-system,sans-serif;box-shadow:0 12px 32px rgba(127,191,63,.35);
        animation:demo-pulse 2.4s ease-in-out infinite}
      @keyframes demo-pulse{0%,100%{transform:scale(1);box-shadow:0 12px 32px rgba(127,191,63,.35)}
        50%{transform:scale(1.045);box-shadow:0 16px 40px rgba(127,191,63,.5)}}
      #demo-card h1{margin:6px 0 0;font-size:26px;letter-spacing:.5px}
      #demo-card p{margin:0;font-size:13px;line-height:1.9;color:#c9d3c4;text-align:center}
      #demo-card .tagline{margin-top:10px;font-size:12px;color:#8fa089}
    `;
    document.head.appendChild(css);
    const cap = document.createElement('div');
    cap.id = 'demo-caption';
    document.body.appendChild(cap);
    window.__demoCaption = (text) => { cap.textContent = text; cap.classList.add('show'); };
    window.__demoRipple = (x, y) => {
      const d = document.createElement('div');
      d.className = 'demo-ripple';
      d.style.left = `${x}px`;
      d.style.top = `${y}px`;
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 800);
    };
    window.__demoCard = (html) => {
      document.getElementById('demo-card')?.remove();
      const card = document.createElement('div');
      card.id = 'demo-card';
      card.innerHTML = html;
      document.body.appendChild(card);
      requestAnimationFrame(() => card.classList.remove('hide'));
      return true;
    };
    window.__demoCardOut = () => document.getElementById('demo-card')?.classList.add('hide');
  });
}
const caption = async (text, holdMs = 0) => {
  await page.evaluate((t) => window.__demoCaption?.(t), text);
  if (holdMs) await sleep(holdMs);
};
async function tap(selector, { hold = 500, real = true } = {}) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  if (!box) { console.log('MISS:', selector); return false; }
  await page.evaluate(({ x, y }) => window.__demoRipple?.(x, y), box);
  await sleep(260); // 让波纹先被录进去
  if (real) await page.mouse.click(box.x, box.y);
  await sleep(hold);
  return true;
}

// ---- 录制 ---------------------------------------------------------------
fs.mkdirSync('docs', { recursive: true });

/** 走真实 file-input 通道导入样例 FIT，等解析弹层结束 */
async function importSample() {
  await page.evaluate(async () => {
    const { SAMPLE_FIT_BASE64, SAMPLE_NAME } = await import('/src/data/sample.ts');
    const bin = atob(SAMPLE_FIT_BASE64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], SAMPLE_NAME));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  let report = '';
  for (let i = 0; i < 80; i += 1) {
    await sleep(300);
    const state = await page.evaluate(() => ({
      title: document.getElementById('import-title')?.textContent ?? '',
      report: document.getElementById('import-report')?.textContent ?? '',
      reportShown: !document.getElementById('import-report')?.hidden,
    }));
    if (state.reportShown || /完成|没有新增|失败/.test(state.title)) {
      report = state.report;
      break;
    }
  }
  return report;
}

await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

// 预热：先导入并打开一次记录，把瓦片缓存灌进 IndexedDB，避免正式录制时长时间转圈
console.log('warm-up...');
await importSample();
await page.evaluate(() => document.getElementById('import-close')?.click());
await page.evaluate(() => document.querySelector('#records-pane .rec')?.click());
await page.waitForFunction(() => window.__fitReady === true, { timeout: 180000 });
await page.evaluate(() => document.getElementById('back-btn')?.click());
await sleep(600);
await page.reload({ waitUntil: 'networkidle2' });
console.log('warm-up done, recording...');

await injectHelpers();
const recorder = await page.screencast({ path: WEBM });
await page.evaluate(() => window.__demoCard(`
  <div class="logo">FM</div>
  <h1>FitMotion</h1>
  <p>把运动记录做成可分享的轨迹视频<br>导入 · 创作 · 背景音乐 · 云端备份</p>
  <span class="tagline">操作演示 · 1 分钟</span>
`));
await sleep(2300);
await page.evaluate(() => window.__demoCardOut());
await sleep(700);

// ① 首页
await caption('① 首页 · 运动记录列表', 2400);

// ② 导入 FIT（同一文件会命中去重）
await caption('② 底部「导入」→ 选择 FIT / GPX / TCX');
await tap('[data-tab="import"]', { hold: 1000 });
await page.evaluate(() => {
  const el = document.getElementById('pick-files');
  const r = el?.getBoundingClientRect();
  if (r) window.__demoRipple?.(r.left + r.width / 2, r.top + r.height / 2);
});
await sleep(500);
await caption('② 解析中 · 轨迹 / 心率 / 海拔写入本地库');
const report = await importSample();
console.log('import report:', report.replace(/\s+/g, ' ').slice(0, 80));
await caption('② 重复文件自动去重 · 不会重复入库', 1900);
await tap('#import-close', { hold: 700 });

// ③ 打开记录（重复导入不会自动跳记录页，先切回去）
await caption('③ 点击记录卡片 · 进入创作页');
await tap('[data-tab="records"]', { hold: 600 });
await tap('#records-pane .rec', { hold: 800 });
await page.waitForFunction(() => window.__fitReady === true, { timeout: 120000 });
await caption('③ 创作页就绪 · 地图 / 轨迹 / 数据面板', 2400);

// ④ 播放
await caption('④ 自动播放 · 轨迹生长 + 实时数据', 4500);

// ⑤ 换音乐
await caption('⑤ 背景音乐 · 点击「更换」选曲');
await tap('#swap-music', { hold: 700 });
await caption('⑤ 三首内置曲目 · 可试听 · 随片长自动循环', 1600);
await tap('#music-sheet [data-track="drive"]', { hold: 1400 });
await caption('⑤ 已切换「疾驰」126 BPM · 进度条跟随播放头', 2600);

// ⑥ 全屏
await caption('⑥ 全屏沉浸播放');
await tap('#fullscreen-btn', { hold: 1400 });
await caption('⑥ 点画面暂停 · 拖进度条跳转 · 底部显示曲名', 5200);
await tap('#fs-exit', { hold: 1000 });

// ⑦ 返回列表 → 设置
await caption('⑦ 返回列表 · 打开「设置」');
await tap('#back-btn', { hold: 900 });
await tap('[data-tab="settings"]', { hold: 1200 });
await caption('⑦ 设置 · 分辨率 / 帧率 / 主题 / 背景音乐', 2800);

// ⑧ 备份
await caption('⑧ 备份 · Gitee + GitHub 双端；轨迹压缩后入库');
await tap('[data-tab="backup"]', { hold: 2600 });
await caption('⑧ 点「绑定」粘贴 Token（仅存本机）· 之后一键同步', 3000);

// 片尾
await page.evaluate(() => window.__demoCard(`
  <div class="logo">FM</div>
  <h1>开始你的第一条轨迹视频</h1>
  <p>选 FIT → 创作页调音乐 → 导出 1080P MP4<br>完整步骤见 docs/使用与验证报告.html</p>
`));
await sleep(3200);

await recorder.stop();
console.log('screencast stopped');

// 先用 webm 量出真实片长（音乐垫要按片长生成，否则 -shortest 会截断画面）
const durProbe = spawnSync(FF, ['-i', WEBM, '-f', 'null', '-'], { encoding: 'utf8' });
const timeRe = /time=(\d+):(\d+):(\d+\.\d+)/g;
let lastTime = null;
let hit;
while ((hit = timeRe.exec(durProbe.stderr))) lastTime = hit;
const dur = lastTime ? (+lastTime[1] * 3600 + +lastTime[2] * 60 + +lastTime[3]) : 0;
console.log('video duration:', dur.toFixed(2), 's');

// ---- 合成真实背景音乐（App 内同一套合成器，长度 = 片长 + 2s）--------------
let bedOk = false;
try {
  await page.evaluate(() => window.__demoCardOut());
  const bedLen = Math.ceil(dur) + 2;
  const bed = await page.evaluate(async (seconds) => {
    const { renderMusicPcm } = await import('/src/audio/synth.ts');
    const pcm = await renderMusicPcm('drive', seconds);
    return pcm ? { b64: pcm.pcm, sampleRate: pcm.sampleRate, channels: pcm.channels } : null;
  }, bedLen);
  if (bed) {
    const pcmBuf = Buffer.from(bed.b64, 'base64');
    const frames = pcmBuf.length / 2 / bed.channels;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmBuf.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(bed.channels, 22);
    header.writeUInt32LE(bed.sampleRate, 24);
    header.writeUInt32LE(bed.sampleRate * bed.channels * 2, 28);
    header.writeUInt16LE(bed.channels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmBuf.length, 40);
    fs.writeFileSync(WAV, Buffer.concat([header, pcmBuf]));
    console.log(`bed wav: ${(frames / bed.sampleRate).toFixed(1)}s ${bed.sampleRate}Hz x${bed.channels}`);
    bedOk = true;
  }
} catch (e) {
  console.log('bed failed:', e.message);
}
await browser.close();

// ---- webm → mp4（H.264 + AAC，音乐垫底 -18dB，首尾淡入淡出）----------------
const filter = bedOk
  ? `[1:a]volume=0.32,afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, dur - 3).toFixed(2)}:d=3[a]`
  : null;
const args = filter
  ? ['-y', '-i', WEBM, '-i', WAV, '-filter_complex', filter, '-map', '0:v', '-map', '[a]',
     '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p',
     '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', MP4]
  : ['-y', '-i', WEBM, '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
     '-pix_fmt', 'yuv420p', MP4];
const r = spawnSync(FF, args, { encoding: 'utf8' });
if (r.status !== 0) console.log('ffmpeg failed:', r.stderr.slice(-800));
else if (fs.existsSync(WAV)) fs.unlinkSync(WAV);

const mb = (p) => (fs.existsSync(p) ? (fs.statSync(p).size / 1048576).toFixed(2) + ' MB' : 'n/a');
console.log(`done:\n  ${WEBM} ${mb(WEBM)}\n  ${MP4} ${mb(MP4)}  (${dur.toFixed(1)}s)`);

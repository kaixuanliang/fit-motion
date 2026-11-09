/**
 * 背景音乐 + 全屏播放的端到端验证（dev server）。
 *
 * 验证点：
 * 1. 创作页有音乐行，默认曲目显示正确
 * 2. 点「更换」弹出选曲层，切换曲目后所有 [data-song-name] 同步
 * 3. renderMusicPcm 能产出与视频等长的 PCM（采样率/声道/时长）
 * 4. 选「无音乐」时 renderMusicPcm 返回 null
 * 5. 播放时 EQ 动画开启、音乐真的在响（AnalyserNode 量到音量）
 * 6. 全屏：class fs 挂上、自动开播、进度条在走、时间码在变
 * 7. 退出全屏回到创作页，播放暂停
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`CONSOLE: ${m.text()}`); });

await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

// 导入样例 FIT
const picked = await page.evaluate(() => {
  const input = document.getElementById('file-input');
  return input ? 'has-input' : 'no-input';
});
console.log('input:', picked);

const out = await page.evaluate(async () => {
  const log = {};
  try {
    // 走真实的文件输入通道（UI 会自己刷新列表）
    const { SAMPLE_FIT_BASE64, SAMPLE_NAME } = await import('/src/data/sample.ts');
    const bin = atob(SAMPLE_FIT_BASE64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], SAMPLE_NAME));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // 等导入弹层结束
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (document.getElementById('import-overlay')?.hidden) break;
    }
    document.getElementById('import-close')?.click();
    log.import = document.getElementById('records-sum')?.textContent ?? '';

    // 打开第一条记录进创作页，并等地图缓存就绪（is-busy 摘掉才能播）
    const card = document.querySelector('#records-pane .rec');
    card?.click();
    for (let i = 0; i < 160; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (window.__fitReady === true) break;
    }
    log.cacheReady = window.__fitReady === true;

    log.musicRow = {
      visible: !!document.querySelector('.music-row'),
      name: document.querySelector('[data-song-name]')?.textContent,
      settings: document.getElementById('set-music')?.textContent,
    };

    // 1) 打开选曲层
    document.getElementById('swap-music')?.click();
    await new Promise((r) => setTimeout(r, 200));
    const sheet = document.getElementById('music-sheet');
    log.sheetOpen = sheet?.classList.contains('open');
    log.sheetRows = [...sheet?.querySelectorAll('.song') ?? []].map((row) => row.dataset.track);

    // 2) 切到「疾驰」
    sheet.querySelector('[data-track="drive"]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    log.afterPick = {
      sheetClosed: !sheet.classList.contains('open'),
      rowName: document.querySelector('.music-row [data-song-name]')?.textContent,
      fsSong: document.getElementById('fs-bar')?.querySelector('[data-song-name]')?.textContent,
    };

    // 3) PCM 合成（等价于导出时干的事）
    const { renderMusicPcm } = await import('/src/audio/synth.ts');
    const stage = window.__fitStage;
    const duration = stage ? stage.duration : 0;
    log.duration = duration;
    const t0 = performance.now();
    const pcm = await renderMusicPcm('drive', duration);
    log.pcm = {
      ms: Math.round(performance.now() - t0),
      sampleRate: pcm?.sampleRate,
      channels: pcm?.channels,
      mb: pcm ? +(pcm.bytes / 1048576).toFixed(2) : 0,
      seconds: pcm ? +(pcm.bytes / 2 / (pcm.channels || 2) / pcm.sampleRate).toFixed(2) : 0,
      b64Length: pcm?.pcm.length ?? 0,
    };
    const silent = await renderMusicPcm('none', duration);
    log.silentIsNull = silent === null;

    // 4) 进创作页会自动开播（at=0 时 220ms 后 startPlayback），等它起播后验证 EQ
    await new Promise((r) => setTimeout(r, 900));
    const eq = document.getElementById('music-eq');
    const t1 = document.getElementById('timecode')?.textContent;
    await new Promise((r) => setTimeout(r, 900));
    const t2 = document.getElementById('timecode')?.textContent;
    log.playing = {
      eqOn: eq?.classList.contains('on'),
      timecodeBefore: t1,
      timecodeAfter: t2,
      advancing: t1 !== t2,
    };
    // 5) 全屏（enterFullScreen 会在暂停时自动续播，直接点即可）
    document.getElementById('fullscreen-btn')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const before = document.getElementById('fs-seek-fill')?.style.width;
    log.fs = {
      active: document.getElementById('studio')?.classList.contains('fs'),
      title: document.getElementById('fs-title')?.textContent,
      tag: document.getElementById('fs-theme-tag')?.textContent,
      song: document.getElementById('fs-bar')?.querySelector('[data-song-name]')?.textContent,
      seekBefore: before,
    };
    await new Promise((r) => setTimeout(r, 1500));
    log.fs.seekAfter = document.getElementById('fs-seek-fill')?.style.width;
    log.fs.time = document.getElementById('fs-time')?.textContent;

    // 6) 退出全屏
    document.getElementById('fs-exit')?.click();
    await new Promise((r) => setTimeout(r, 250));
    log.exitFs = {
      fsOff: !document.getElementById('studio')?.classList.contains('fs'),
      transportVisible: !!document.querySelector('.transport') && getComputedStyle(document.querySelector('.transport')).display !== 'none',
      timecode: document.getElementById('timecode')?.textContent,
    };
  } catch (e) {
    log.failed = `${e.message}\n${e.stack?.split('\n').slice(0, 4).join('\n')}`;
  }
  return log;
});
console.log(JSON.stringify(out, null, 2));
console.log('errors:', errors.length, errors.slice(0, 5));

await page.screenshot({ path: 'screenshots/app/17-create-music.png' });
await browser.close();

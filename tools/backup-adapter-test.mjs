/**
 * 备份适配器容错回归：403 原因透出、Gitee 大文件 content 缺失、厂商网关回 HTML。
 * 用 fetch mock 构造远端响应，不打真实网络。
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

const out = await page.evaluate(async () => {
  const { createAdapter, RemoteError } = await import('/src/backup/adapter.ts');
  const config = { token: 'tkn', owner: 'me', repo: 'fit', branch: 'main' };
  const original = window.fetch;
  const results = {};

  const mock = (handler) => { window.fetch = handler; };
  const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const capture = async (fn) => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), status: error instanceof RemoteError ? error.status : null };
    }
  };

  // 1) GitHub 403：权限不足，要把远端 message 和修改指引带出来
  mock(() => json({ message: 'Resource not accessible by personal access token' }, 403));
  const gh = createAdapter('github', config);
  results.github403 = await capture(() => gh.get('fitmotion/manifest.json'));

  // 2) GitHub 403 + 限流头
  mock(() => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }));
  results.githubRateLimit = await capture(() => gh.get('fitmotion/manifest.json'));

  // 3) Gitee 文件超限：contents 只回元信息，raw 兜底应拿到正文
  const manifest = '{"app":"fitmotion","version":1,"updated":1,"activities":[]}';
  mock((url) => {
    const u = String(url);
    if (u.includes('/contents/')) return json({ type: 'file', encoding: 'base64', content: null, sha: 'sha-1', size: 2 * 1024 * 1024 });
    if (u.includes('/raw/')) return new Response(manifest, { status: 200 });
    return json({ message: 'unexpected ' + u }, 500);
  });
  const gitee = createAdapter('gitee', config);
  const giteeNull = await capture(() => gitee.get('fitmotion/manifest.json'));
  results.giteeContentNull = giteeNull.ok
    ? { ok: true, textMatches: giteeNull.value.text === manifest, sha: giteeNull.value.sha }
    : giteeNull;

  // 4) Gitee 网关回 HTML（200）：raw 兜底
  mock((url) => {
    const u = String(url);
    if (u.includes('/contents/')) return new Response('<html><body>login</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.includes('/raw/')) return new Response(manifest, { status: 200 });
    return json({}, 500);
  });
  const giteeHtml = await capture(() => gitee.get('fitmotion/manifest.json'));
  results.giteeHtml = giteeHtml.ok ? { ok: true, textMatches: giteeHtml.value.text === manifest } : giteeHtml;

  // 5) 两路都拿不到：错误里要带 body 摘要
  mock((url) => {
    const u = String(url);
    if (u.includes('/contents/')) return json({ content: null, sha: 'x', type: 'file' });
    return new Response('nope', { status: 401 });
  });
  results.giteeHardFail = await capture(() => gitee.get('fitmotion/manifest.json'));

  // 6) Gitee 怪癖：文件不存在时 contents 回父目录列表（200 + []），raw 404 —— 应视为远端无文件
  mock((url) => {
    const u = String(url);
    if (u.includes('/contents/')) return json([]);
    if (u.includes('/raw/')) return json({ message: 'Not Found' }, 404);
    return json({}, 500);
  });
  const giteeDir = await capture(() => gitee.get('fitmotion/manifest.json'));
  results.giteeDirListing = giteeDir.ok ? { ok: true, isNull: giteeDir.value === null } : giteeDir;

  // 7) 正常 base64 内容仍能解出
  const b64 = btoa(manifest);
  mock(() => json({ content: b64, encoding: 'base64', sha: 'sha-2' }));
  const normal = await capture(() => gitee.get('fitmotion/manifest.json'));
  results.normalBase64 = normal.ok ? { ok: true, textMatches: normal.value.text === manifest, sha: normal.value.sha } : normal;

  // 8) WebView 缓存旧 sha：GET 连续返回过期 sha，PUT 撞 409 —— 重试轮询应最终成功
  const b64txt = (t) => btoa(t);
  let staleLeft = 2;
  let putCount = 0;
  let sawNonce = false;
  mock((url, init) => {
    const u = String(url);
    if (u.includes('_=')) sawNonce = true;
    const bodyOf = (init) => JSON.parse((init && init.body) || '{}');
    if (u.includes('/contents/')) {
      if ((init?.method || 'GET').toUpperCase() === 'PUT') {
        putCount += 1;
        if (bodyOf(init).sha === 'fresh-sha') return json({ content: { sha: 'written-1' } });
        return json({ message: 'manifest.json does not match ' + bodyOf(init).sha }, 409);
      }
      if (staleLeft > 0) { staleLeft -= 1; return json({ content: b64txt('old'), encoding: 'base64', sha: 'stale-sha' }); }
      return json({ content: b64txt('new'), encoding: 'base64', sha: 'fresh-sha' });
    }
    return json({}, 500);
  });
  const ghRetry = createAdapter('github', config);
  results.cachedStaleSha = await capture(() => ghRetry.put('fitmotion/manifest.json', 'new', '更新清单'));
  results.cachedStaleSha = { ...results.cachedStaleSha, putCount, sawNonce };

  // 9) 容量：两家都不该拿 GET /repos 的 size，而是累加 git trees 里
  //    fitmotion/ 下的 blob（Gitee 没有 size 字段、GitHub 的 size 滞后）
  const tree = {
    sha: 'tree-1',
    truncated: false,
    tree: [
      { path: 'README.md', type: 'blob', size: 999999 },
      { path: 'fitmotion', type: 'tree', size: 0 },
      { path: 'fitmotion/manifest.json', type: 'blob', size: 4096 },
      { path: 'fitmotion/tracks/a.fmt', type: 'blob', size: 200000 },
      { path: 'fitmotion/tracks/b.fmt', type: 'blob', size: 100000 },
    ],
  };
  let sawTreeUrl = { github: '', gitee: '' };
  mock((url) => {
    const u = String(url);
    if (u.includes('/git/trees/')) { sawTreeUrl.github = u; return json(tree); }
    return json({ message: 'unexpected ' + u }, 500);
  });
  const ghUsage = createAdapter('github', config);
  results.usageGithub = await capture(() => ghUsage.usage());

  mock((url) => {
    const u = String(url);
    if (u.includes('/git/trees/')) { sawTreeUrl.gitee = u; return json(tree); }
    return json({ message: 'unexpected ' + u }, 500);
  });
  const giteeUsage = createAdapter('gitee', config);
  results.usageGitee = await capture(() => giteeUsage.usage());

  // 10) trees 接口挂了 → 返回 null，交给上层兜底而不是报 0
  mock(() => json({ message: 'boom' }, 500));
  results.usageFailed = await capture(() => ghUsage.usage());

  results.usageUrls = sawTreeUrl;

  window.fetch = original;
  return results;
});

console.log(JSON.stringify(out, null, 2));
console.log('errors', errors.slice(0, 3));
await browser.close();

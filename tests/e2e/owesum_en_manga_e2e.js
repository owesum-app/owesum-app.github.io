// OweSum 英語版「How OweSum Works」E2E（Playwright・本番通信なし）。
//
// 目的：英語版(/en/)トップに追加した8枚の英語漫画セクションが、01〜08の順序で正しく揃い、
// 画像404・console errorを出さず、スマホは1列・PC(768px以上)は2列で表示され、スマホ390px幅で
// 横スクロールが発生せず、画像がトリミングされていないこと、表示順が
// 「Create a new group → Your groups → How OweSum Works → Restore → Analytics」であること、
// 日本語版(/ja/)には英語漫画が混入せず日本語漫画8枚のままであること、
// 既存の主要ボタン（Create a new group / Create group）が従来どおり操作できることを検証する。
//
// 本番Supabase・Googleへの通信はすべてルート横取りで遮断する（owesum_ja_manga_e2e.jsと同方式）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = 'C:\\Users\\narim\\OweSum';
const MIME = { '.html': 'text/html;charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

let PASS = 0, FAIL = 0; const fails = [];
function ok(name, cond, extra) { if (cond) { PASS++; } else { FAIL++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); } }

const NETG = { gaObserved: 0, gaCaptured: 0, supaObserved: 0, supaHandledTotal: 0, supaFallback: 0, otherExternal: [] };
const GA_HOST_RE = /(\.|^)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|google\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com|gstatic\.com)$/;
const SUPA_HOST_RE = /(\.|^)supabase\.co$/;
const KNOWN_HOST_RE = /^(localhost|127\.0\.0\.1|esm\.sh|cdn\.jsdelivr\.net)$/;

async function installNetGuard(ctx) {
  await ctx.route(u => GA_HOST_RE.test(u.hostname), route => {
    NETG.gaCaptured++;
    const url = route.request().url();
    if (url.includes('/gtag/js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* e2e guard: gtag.js blocked */' });
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.route(u => SUPA_HOST_RE.test(u.hostname), route => {
    NETG.supaFallback++;
    NETG.supaHandledTotal++;
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"blocked by e2e guard"}' });
  });
  await ctx.addInitScript(() => {
    try {
      window.WebSocket = class {
        constructor() { this.readyState = 3; }
        addEventListener() {} removeEventListener() {} send() {} close() {}
        set onopen(v) {} set onclose(v) {} set onerror(v) {} set onmessage(v) {}
      };
    } catch (e) {}
  });
  ctx.on('request', req => {
    let h; try { const u = new URL(req.url()); if (u.protocol !== 'http:' && u.protocol !== 'https:') return; h = u.hostname; } catch (e) { return; }
    if (GA_HOST_RE.test(h)) NETG.gaObserved++;
    else if (SUPA_HOST_RE.test(h)) NETG.supaObserved++;
    else if (!KNOWN_HOST_RE.test(h)) NETG.otherExternal.push(req.method() + ' ' + req.url());
  });
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const fp = path.join(ROOT, p);
  fs.readFile(fp, (e, data) => {
    if (e) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

function makeDb(state) {
  const rec = { posts: [], idc: 9000 };
  const handler = route => {
    const req = route.request();
    NETG.supaHandledTotal++;
    const url = new URL(req.url());
    if (!url.pathname.includes('/rest/v1/')) return route.abort();
    const table = url.pathname.split('/').pop();
    const method = req.method();
    if (!(table in state)) return route.fulfill({ status: 404, contentType: 'application/json', body: '[]' });
    if (method === 'GET') {
      let rows = state[table].slice();
      for (const [k, v] of url.searchParams) {
        const m = /^eq\.(.*)$/.exec(v);
        if (m) rows = rows.filter(r => String(r[k]) === m[1]);
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }
    if (method === 'POST') {
      let body = [];
      try { body = JSON.parse(req.postData() || '[]'); } catch (e) { body = []; }
      if (!Array.isArray(body)) body = [body];
      const inserted = body.map(r => { const row = Object.assign({ id: ++rec.idc }, r); state[table].push(row); return row; });
      rec.posts.push({ table, rows: inserted });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(inserted) });
    }
    return route.fulfill({ status: 204, body: '' });
  };
  return { handler, rec };
}

async function newCtx(browser, viewport) {
  const ctx = await browser.newContext({ viewport });
  await installNetGuard(ctx);
  await ctx.addInitScript(() => { window.__consoleErrors = []; });
  const page = await ctx.newPage();
  const notFound = [];
  page.on('response', r => { if (r.status() === 404) notFound.push(r.url()); });
  page.on('console', m => { if (m.type() === 'error') page.evaluate(t => window.__consoleErrors.push(t), m.text()).catch(() => {}); });
  page.on('pageerror', e => { fails.push('PAGEERROR: ' + e.message); FAIL++; });
  return { ctx, page, notFound };
}

async function jsErrors(page) {
  return page.evaluate(() => (window.__consoleErrors || []).filter(e => !/favicon|esm\.sh|net::|Failed to load resource|WebSocket|realtime|googletagmanager|jsdelivr/i.test(e)));
}

const EXPECTED_SRCS = Array.from({ length: 8 }, (_, i) => `/assets/images/manga/en/owesum-manga-en-${String(i + 1).padStart(2, '0')}.png`);
const EXPECTED_ALTS = [
  'Six friends having dinner at an Italian restaurant',
  'John paying for the first dinner',
  'Three friends heading home while three continue to a wine bar',
  'Three friends at a wine bar with one person paying',
  'Six friends struggling to work out who owes what',
  'Entering an expense into OweSum',
  'OweSum showing exactly who should pay whom',
  'Recording expenses with OweSum during a group trip',
];

async function mangaInfo(page) {
  return page.evaluate(() => {
    const manga = document.getElementById('manga-section-en');
    if (!manga) return null;
    const heading = document.getElementById('manga-heading');
    const imgs = Array.from(manga.querySelectorAll('img.manga-img'));
    const grid = manga.querySelector('.manga-grid');
    // 表示順の判定：実際に画面上で見える要素だけを対象に、上から並んだ縦位置(top)を取得する。
    // モバイルではhero-btn(モーダル起動用)が主CTA、PCでは#gnameのインライン作成フォームが主CTAとして見える
    // （どちらか一方は常にdisplay:noneで非表示）。
    function visibleTop(id) {
      const el = document.getElementById(id);
      if (!el) return null;
      let n = el;
      while (n) {
        if (n instanceof Element && getComputedStyle(n).display === 'none') return null;
        n = n.parentElement;
      }
      const r = el.getBoundingClientRect();
      return Math.round(r.top + window.scrollY);
    }
    const ctaTop = visibleTop('btn-hero-create') !== null ? visibleTop('btn-hero-create') : visibleTop('gname');
    const orderTops = {
      cta: ctaTop,
      myGroups: visibleTop('my-groups'),
      manga: visibleTop('manga-section-en'),
      restore: visibleTop('restore-sp-wrap'),
      analytics: visibleTop('analytics-note'),
    };

    return {
      headingText: heading ? heading.textContent.trim() : null,
      leadText: manga.querySelector('.manga-lead') ? manga.querySelector('.manga-lead').textContent.trim() : null,
      count: imgs.length,
      srcs: imgs.map(i => i.getAttribute('src')),
      alts: imgs.map(i => i.getAttribute('alt')),
      loadings: imgs.map(i => i.getAttribute('loading')),
      decodings: imgs.map(i => i.getAttribute('decoding')),
      attrSizes: imgs.map(i => [i.getAttribute('width'), i.getAttribute('height')]),
      naturalSizes: imgs.map(i => [i.naturalWidth, i.naturalHeight]),
      rects: imgs.map(i => { const r = i.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
      gridColumnsCount: grid ? getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length : null,
      orderTops,
      bodyScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
}

function orderIsCorrect(t) {
  return t.cta !== null && t.myGroups !== null && t.manga !== null && t.restore !== null && t.analytics !== null &&
    t.cta < t.myGroups && t.myGroups < t.manga && t.manga < t.restore && t.restore < t.analytics;
}

function notCropped(info) {
  return info.rects.every((r, i) => {
    const nat = info.naturalSizes[i];
    const natRatio = nat[0] / nat[1];
    const rendRatio = r[0] / r[1];
    return Math.abs(natRatio - rendRatio) / natRatio < 0.02;
  });
}

async function waitManga(page) {
  await page.waitForSelector('#manga-section-en', { timeout: 15000 });
  await page.waitForFunction(() => {
    const imgs = document.querySelectorAll('#manga-section-en img.manga-img');
    return imgs.length === 8 && Array.from(imgs).every(i => i.complete && i.naturalWidth > 0);
  }, { timeout: 15000 });
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const BASE_EN = `http://localhost:${PORT}/en/`;
  const BASE_JA = `http://localhost:${PORT}/ja/`;
  const browser = await chromium.launch();

  // ---------- A. スマホ(390px)：8枚・順序・自然寸法・404・1列・横スクロールなし・表示順 ----------
  {
    const { ctx, page, notFound } = await newCtx(browser, { width: 390, height: 3600 });
    const statuses = [];
    page.on('response', r => { if (r.url().includes('/manga/en/')) statuses.push([r.url().split('/').pop(), r.status()]); });
    await page.goto(BASE_EN, { waitUntil: 'networkidle' });
    await waitManga(page);
    const info = await mangaInfo(page);

    ok('[A] スマホ: 見出しが「How OweSum Works」', info.headingText === 'How OweSum Works', String(info.headingText));
    ok('[A] スマホ: 説明文が「See how OweSum makes group expenses easy.」', info.leadText === 'See how OweSum makes group expenses easy.', String(info.leadText));
    ok('[A] スマホ: 英語漫画が8枚存在する', info.count === 8, String(info.count));
    ok('[A] スマホ: 01〜08の順序が正しい', JSON.stringify(info.srcs) === JSON.stringify(EXPECTED_SRCS), JSON.stringify(info.srcs));
    ok('[A] スマホ: 8枚すべて200応答', statuses.length === 8 && statuses.every(s => s[1] === 200), JSON.stringify(statuses));
    ok('[A] スマホ: 8枚すべてnaturalWidth>0', info.naturalSizes.every(s => s[0] > 0), JSON.stringify(info.naturalSizes));
    ok('[A] スマホ: 8枚すべてnaturalHeight>0', info.naturalSizes.every(s => s[1] > 0), JSON.stringify(info.naturalSizes));
    ok('[A] スマホ: width/height属性が実寸(1122x1402)と一致', info.attrSizes.every((a, i) => Number(a[0]) === info.naturalSizes[i][0] && Number(a[1]) === info.naturalSizes[i][1]), JSON.stringify({ attr: info.attrSizes, nat: info.naturalSizes }));
    ok('[A] スマホ: 全枚loading="lazy"', info.loadings.every(v => v === 'lazy'), JSON.stringify(info.loadings));
    ok('[A] スマホ: 全枚decoding="async"', info.decodings.every(v => v === 'async'), JSON.stringify(info.decodings));
    ok('[A] スマホ: alt属性が指定どおりの英語', JSON.stringify(info.alts) === JSON.stringify(EXPECTED_ALTS), JSON.stringify(info.alts));
    ok('[A] スマホ: 画像404が0件', notFound.filter(u => u.includes('/manga/')).length === 0, JSON.stringify(notFound));
    ok('[A] スマホ: 1列表示（grid-template-columnsが1値）', info.gridColumnsCount === 1, String(info.gridColumnsCount));
    ok('[A] スマホ390px: 横スクロールが発生しない', info.bodyScrollWidth <= info.innerWidth, `scrollWidth=${info.bodyScrollWidth} innerWidth=${info.innerWidth}`);
    ok('[A] スマホ: 表示順が「Create a new group→Your groups→How OweSum Works→Restore→Analytics」', orderIsCorrect(info.orderTops), JSON.stringify(info.orderTops));
    ok('[A] スマホ: 参加中グループ一覧が漫画より前にある', info.orderTops.myGroups < info.orderTops.manga, JSON.stringify(info.orderTops));
    ok('[A] スマホ: バックアップ復元・アクセス解析が漫画より後にある', info.orderTops.manga < info.orderTops.restore && info.orderTops.restore < info.orderTops.analytics, JSON.stringify(info.orderTops));
    ok('[A] スマホ: 画像がトリミングされていない（レンダー比率が自然比率に一致）', notCropped(info), JSON.stringify({ rects: info.rects, naturalSizes: info.naturalSizes }));

    const errs = await jsErrors(page);
    ok('[A] スマホ: console errorが0件', errs.length === 0, JSON.stringify(errs));
    await ctx.close();
  }

  // ---------- B. PC(1280px)：8枚・順序・404・2列・トリミングなし・表示順 ----------
  {
    const { ctx, page, notFound } = await newCtx(browser, { width: 1280, height: 1000 });
    const statuses = [];
    page.on('response', r => { if (r.url().includes('/manga/en/')) statuses.push([r.url().split('/').pop(), r.status()]); });
    await page.goto(BASE_EN, { waitUntil: 'networkidle' });
    await waitManga(page);
    const info = await mangaInfo(page);

    ok('[B] PC: 見出しが「How OweSum Works」', info.headingText === 'How OweSum Works', String(info.headingText));
    ok('[B] PC: 英語漫画が8枚存在する', info.count === 8, String(info.count));
    ok('[B] PC: 01〜08の順序が正しい', JSON.stringify(info.srcs) === JSON.stringify(EXPECTED_SRCS), JSON.stringify(info.srcs));
    ok('[B] PC: 8枚すべて200応答', statuses.length === 8 && statuses.every(s => s[1] === 200), JSON.stringify(statuses));
    ok('[B] PC: 8枚すべてnaturalWidth/Height>0', info.naturalSizes.every(s => s[0] > 0 && s[1] > 0), JSON.stringify(info.naturalSizes));
    ok('[B] PC: 画像404が0件', notFound.filter(u => u.includes('/manga/')).length === 0, JSON.stringify(notFound));
    ok('[B] PC: 2列表示（grid-template-columnsが2値）', info.gridColumnsCount === 2, String(info.gridColumnsCount));
    ok('[B] PC: 左上から01,02,03,04,05,06,07,08の並び（DOM順＝グリッド順）', JSON.stringify(info.srcs) === JSON.stringify(EXPECTED_SRCS), JSON.stringify(info.srcs));
    ok('[B] PC: 画像がトリミングされていない（レンダー比率が自然比率に一致）', notCropped(info), JSON.stringify({ rects: info.rects, naturalSizes: info.naturalSizes }));
    ok('[B] PC: 表示順が「Create a new group→Your groups→How OweSum Works→Restore→Analytics」', orderIsCorrect(info.orderTops), JSON.stringify(info.orderTops));
    ok('[B] PC: 参加中グループ一覧が漫画より前にある', info.orderTops.myGroups < info.orderTops.manga, JSON.stringify(info.orderTops));
    ok('[B] PC: バックアップ復元・アクセス解析が漫画より後にある', info.orderTops.manga < info.orderTops.restore && info.orderTops.restore < info.orderTops.analytics, JSON.stringify(info.orderTops));

    const errs = await jsErrors(page);
    ok('[B] PC: console errorが0件', errs.length === 0, JSON.stringify(errs));
    await ctx.close();
  }

  // ---------- C. タブレット(768px/1024px)：読みやすさ優先で1列または2列 ----------
  {
    for (const w of [768, 1024]) {
      const { ctx, page } = await newCtx(browser, { width: w, height: 1400 });
      await page.goto(BASE_EN, { waitUntil: 'networkidle' });
      await waitManga(page);
      const info = await mangaInfo(page);
      ok(`[C] タブレット${w}px: 1列または2列で表示される`, info.gridColumnsCount === 1 || info.gridColumnsCount === 2, String(info.gridColumnsCount));
      ok(`[C] タブレット${w}px: 横スクロールが発生しない`, info.bodyScrollWidth <= info.innerWidth, `scrollWidth=${info.bodyScrollWidth} innerWidth=${info.innerWidth}`);
      ok(`[C] タブレット${w}px: 画像がトリミングされていない`, notCropped(info), JSON.stringify(info.rects));
      await ctx.close();
    }
  }

  // ---------- D. 日本語版(/ja/)は無影響：英語漫画が存在せず日本語漫画8枚のまま ----------
  {
    const { ctx, page, notFound } = await newCtx(browser, { width: 1280, height: 1000 });
    await page.goto(BASE_JA, { waitUntil: 'networkidle' });
    await page.waitForSelector('#manga-section-ja', { timeout: 15000 });
    const ja = await page.evaluate(() => ({
      hasEnManga: !!document.getElementById('manga-section-en') || document.body.innerHTML.includes('/assets/images/manga/en/'),
      jaCount: document.querySelectorAll('#manga-section-ja img.manga-img').length,
      jaSrcs: Array.from(document.querySelectorAll('#manga-section-ja img.manga-img')).map(i => i.getAttribute('src')),
      heading: document.getElementById('manga-heading') ? document.getElementById('manga-heading').textContent.trim() : null,
    }));
    ok('[D] 日本語版: 英語漫画が存在しない', ja.hasEnManga === false, String(ja.hasEnManga));
    ok('[D] 日本語版: 日本語漫画が8枚のまま', ja.jaCount === 8, String(ja.jaCount));
    ok('[D] 日本語版: 日本語漫画のsrcが01〜08のまま', JSON.stringify(ja.jaSrcs) === JSON.stringify(Array.from({ length: 8 }, (_, i) => `/assets/images/manga/ja/owesum-manga-ja-${String(i + 1).padStart(2, '0')}.png`)), JSON.stringify(ja.jaSrcs));
    ok('[D] 日本語版: 見出しが「マンガでわかる OweSumの使い方」のまま', ja.heading === 'マンガでわかる OweSumの使い方', String(ja.heading));
    ok('[D] 日本語版: 画像404が0件', notFound.filter(u => u.includes('/manga/')).length === 0, JSON.stringify(notFound));
    const errs = await jsErrors(page);
    ok('[D] 日本語版: console errorが0件', errs.length === 0, JSON.stringify(errs));
    await ctx.close();
  }

  // ---------- E. 英語版スマホ：主要ボタン（Create a new group）が従来どおり動作する ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 3600 });
    await page.goto(BASE_EN, { waitUntil: 'load' });
    await page.waitForSelector('#btn-hero-create', { timeout: 15000 });
    await page.click('#btn-hero-create');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('create-bg')).display === 'flex', { timeout: 15000 });
    const opened = await page.evaluate(() => getComputedStyle(document.getElementById('create-bg')).display === 'flex');
    ok('[E] 英語版スマホ: 「Create a new group」クリックで作成モーダルが開く', opened === true, String(opened));
    await ctx.close();
  }

  // ---------- F. 英語版PC：グループ作成が従来どおり動作する（Supabase横取り・本番書込み0） ----------
  {
    const state = { groups: [], members: [], expenses: [], rates: [] };
    const db = makeDb(state);
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 1000 });
    await ctx.route(u => SUPA_HOST_RE.test(u.hostname), db.handler);
    await page.goto(BASE_EN, { waitUntil: 'load' });
    await page.waitForSelector('#btn-create-group', { timeout: 15000 });
    await page.fill('#gname', 'E2E EN manga check');
    await page.click('#btn-create-group');
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    const shown = await page.evaluate(() => document.getElementById('p-main').classList.contains('show'));
    ok('[F] 英語版PC: 「Create group」クリックでグループ作成・画面遷移する', shown === true, String(shown));
    ok('[F] 英語版PC: グループ作成insertが1件のみ発行される', db.rec.posts.filter(p => p.table === 'groups').length === 1, JSON.stringify(db.rec.posts));
    ok('[F] 英語版PC: 基準通貨USDが従来どおり明示される', db.rec.posts.filter(p => p.table === 'groups').every(p => p.rows.every(r => r.base_currency === 'USD')), JSON.stringify(db.rec.posts));
    const errs = await jsErrors(page);
    ok('[F] 英語版PC: console errorが0件', errs.length === 0, JSON.stringify(errs));
    await ctx.close();
  }

  // ---------- G. 英語版：バックアップ復元導線が壊れていない ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 1000 });
    await page.goto(BASE_EN, { waitUntil: 'load' });
    await page.waitForSelector('#restore-sp-wrap', { timeout: 15000 });
    const restore = await page.evaluate(() => ({
      hasSpBtn: !!document.getElementById('btn-restore-sp'),
      hasFileInput: !!document.getElementById('restore-file'),
      spVisible: getComputedStyle(document.getElementById('restore-sp-wrap')).display !== 'none',
    }));
    ok('[G] 英語版PC: 復元リンクが表示されている', restore.spVisible === true, JSON.stringify(restore));
    ok('[G] 英語版PC: 復元ボタン・ファイル入力が存在する', restore.hasSpBtn && restore.hasFileInput, JSON.stringify(restore));
    await ctx.close();
  }

  // ---------- H. 通信安全 ----------
  ok('[H] Supabase宛の発行数＝横取り数（本番到達0件）', NETG.supaObserved === NETG.supaHandledTotal, `observed=${NETG.supaObserved} handled=${NETG.supaHandledTotal}`);
  ok('[H] Google向け通信が外部へ通過していない（実通信0）', NETG.gaObserved === NETG.gaCaptured, `observed=${NETG.gaObserved} captured=${NETG.gaCaptured}`);
  ok('[H] 想定外の外部通信0件', NETG.otherExternal.length === 0, NETG.otherExternal.slice(0, 5).join(' || '));

  await browser.close();
  server.close();
  console.log(`[netguard] Google捕捉=${NETG.gaCaptured} Google外部通過=${NETG.gaObserved - NETG.gaCaptured} Supabase観測=${NETG.supaObserved}（うちフォールバック横取り=${NETG.supaFallback}） 想定外外部通信=${NETG.otherExternal.length}`);
  console.log(`\n==== 英語版マンガ導線E2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

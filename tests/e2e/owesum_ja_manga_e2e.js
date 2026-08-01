// OweSum 日本語版「マンガでわかる使い方」E2E（Playwright・本番通信なし）。
//
// 目的：日本語版(/ja/)トップに追加した8枚のマンガ画像セクションが、01〜08の順序で正しく揃い、
// 画像404・console errorを出さず、スマホは1列・PC(768px以上)は2列で表示され、スマホ390px幅で
// 横スクロールが発生せず、画像がトリミングされていないこと、英語版(/en/)には一切影響がないこと、
// 既存の主要ボタン（新しいグループを作る）が従来どおり操作できることを検証する。
//
// 本番Supabase・Googleへの通信はすべてルート横取りで遮断する（owesum_en_locale_e2e.jsと同方式）。
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
      let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (e) {}
      rec.posts.push({ table, body });
      const rows = (Array.isArray(body) ? body : [body]).map(r => Object.assign({ id: 'new-' + (rec.idc++), created_at: '2026-08-01T00:00:00Z' }, r));
      state[table].push(...rows);
      const accept = (req.headers()['accept'] || '');
      return route.fulfill({ status: 201, contentType: 'application/json', body: accept.includes('pgrst.object') ? JSON.stringify(rows[0]) : JSON.stringify(rows) });
    }
    return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"blocked by e2e"}' });
  };
  return { rec, handler };
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

async function mangaInfo(page) {
  return page.evaluate(() => {
    const manga = document.getElementById('manga-section-ja');
    if (!manga) return null;
    const heading = document.getElementById('manga-heading');
    const imgs = Array.from(manga.querySelectorAll('img.manga-img'));
    const grid = manga.querySelector('.manga-grid');
    const myGroups = document.getElementById('my-groups');
    const wrapDiv = document.querySelector('#p-group > div.wrap');
    // 「参加中グループ一覧より前」の判定：DOM上でmangaがmyGroupsより先行しているか
    const posVsGroups = myGroups ? (manga.compareDocumentPosition(myGroups) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : null;
    return {
      headingText: heading ? heading.textContent : null,
      count: imgs.length,
      srcs: imgs.map(i => i.getAttribute('src')),
      naturalSizes: imgs.map(i => [i.naturalWidth, i.naturalHeight]),
      rects: imgs.map(i => { const r = i.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
      gridColumnsCount: grid ? getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length : null,
      mangaBeforeMyGroups: posVsGroups,
      mangaNextSiblingIsWrap: manga.nextElementSibling === wrapDiv,
      bodyScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const BASE_EN = `http://localhost:${PORT}/en/`;
  const BASE_JA = `http://localhost:${PORT}/ja/`;
  const browser = await chromium.launch();

  // ---------- A. スマホ(390px)：8枚・順序・自然寸法・404・1列・横スクロールなし・グループ一覧より前 ----------
  {
    const { ctx, page, notFound } = await newCtx(browser, { width: 390, height: 3600 });
    await page.goto(BASE_JA, { waitUntil: 'networkidle' });
    await page.waitForSelector('#manga-section-ja', { timeout: 15000 });
    await page.waitForFunction(() => {
      const imgs = document.querySelectorAll('#manga-section-ja img.manga-img');
      return imgs.length === 8 && Array.from(imgs).every(i => i.complete && i.naturalWidth > 0);
    }, { timeout: 15000 });
    const info = await mangaInfo(page);

    ok('[A] スマホ: マンガ見出しが正しい', info.headingText === 'マンガでわかる OweSumの使い方', String(info.headingText));
    ok('[A] スマホ: マンガ画像が8枚存在する', info.count === 8, String(info.count));
    ok('[A] スマホ: 01〜08の順序が正しい', JSON.stringify(info.srcs) === JSON.stringify(Array.from({ length: 8 }, (_, i) => `/assets/images/manga/ja/owesum-manga-ja-${String(i + 1).padStart(2, '0')}.png`)), JSON.stringify(info.srcs));
    ok('[A] スマホ: 8枚すべてnaturalWidth>0', info.naturalSizes.every(s => s[0] > 0), JSON.stringify(info.naturalSizes));
    ok('[A] スマホ: 8枚すべてnaturalHeight>0', info.naturalSizes.every(s => s[1] > 0), JSON.stringify(info.naturalSizes));
    ok('[A] スマホ: 画像404が0件', notFound.filter(u => u.includes('/manga/')).length === 0, JSON.stringify(notFound));
    ok('[A] スマホ: 1列表示（grid-template-columnsが1値）', info.gridColumnsCount === 1, String(info.gridColumnsCount));
    ok('[A] スマホ390px: 横スクロールが発生しない', info.bodyScrollWidth <= info.innerWidth, `scrollWidth=${info.bodyScrollWidth} innerWidth=${info.innerWidth}`);
    ok('[A] スマホ: マンガが参加中グループ一覧より前にある', info.mangaBeforeMyGroups === true, String(info.mangaBeforeMyGroups));
    ok('[A] スマホ: 画像がトリミングされていない（レンダー比率が自然比率に一致）', info.rects.every((r, i) => {
      const nat = info.naturalSizes[i];
      const natRatio = nat[0] / nat[1];
      const rendRatio = r[0] / r[1];
      return Math.abs(natRatio - rendRatio) / natRatio < 0.02;
    }), JSON.stringify({ rects: info.rects, naturalSizes: info.naturalSizes }));

    const errs = await jsErrors(page);
    ok('[A] スマホ: console errorが0件', errs.length === 0, JSON.stringify(errs));
    await ctx.close();
  }

  // ---------- B. PC(1280px)：8枚・順序・自然寸法・404・2列・ヒーロー直下（.wrapの直前）に配置 ----------
  {
    const { ctx, page, notFound } = await newCtx(browser, { width: 1280, height: 1000 });
    await page.goto(BASE_JA, { waitUntil: 'networkidle' });
    await page.waitForSelector('#manga-section-ja', { timeout: 15000 });
    await page.waitForFunction(() => {
      const imgs = document.querySelectorAll('#manga-section-ja img.manga-img');
      return imgs.length === 8 && Array.from(imgs).every(i => i.complete && i.naturalWidth > 0);
    }, { timeout: 15000 });
    const info = await mangaInfo(page);

    ok('[B] PC: マンガ画像が8枚存在する', info.count === 8, String(info.count));
    ok('[B] PC: 01〜08の順序が正しい', JSON.stringify(info.srcs) === JSON.stringify(Array.from({ length: 8 }, (_, i) => `/assets/images/manga/ja/owesum-manga-ja-${String(i + 1).padStart(2, '0')}.png`)), JSON.stringify(info.srcs));
    ok('[B] PC: 8枚すべてnaturalWidth/Height>0', info.naturalSizes.every(s => s[0] > 0 && s[1] > 0), JSON.stringify(info.naturalSizes));
    ok('[B] PC: 画像404が0件', notFound.filter(u => u.includes('/manga/')).length === 0, JSON.stringify(notFound));
    ok('[B] PC: 2列表示（grid-template-columnsが2値）', info.gridColumnsCount === 2, String(info.gridColumnsCount));
    ok('[B] PC: 画像がトリミングされていない（レンダー比率が自然比率に一致）', info.rects.every((r, i) => {
      const nat = info.naturalSizes[i];
      const natRatio = nat[0] / nat[1];
      const rendRatio = r[0] / r[1];
      return Math.abs(natRatio - rendRatio) / natRatio < 0.02;
    }), JSON.stringify({ rects: info.rects, naturalSizes: info.naturalSizes }));
    ok('[B] PC: マンガがヒーロー直下（.wrapの直前）に移動している', info.mangaNextSiblingIsWrap === true, String(info.mangaNextSiblingIsWrap));

    const errs = await jsErrors(page);
    ok('[B] PC: console errorが0件', errs.length === 0, JSON.stringify(errs));
    await ctx.close();
  }

  // ---------- C. 英語版(/en/)には漫画セクションが一切存在しない ----------
  {
    const { ctx, page, notFound } = await newCtx(browser, { width: 1280, height: 1000 });
    await page.goto(BASE_EN, { waitUntil: 'networkidle' });
    await page.waitForSelector('.lang-switch-link', { timeout: 15000 });
    const hasManga = await page.evaluate(() => !!document.getElementById('manga-section-ja') || !!document.querySelector('.manga-section') || document.body.innerHTML.includes('/assets/images/manga/'));
    ok('[C] 英語版: マンガセクションが存在しない', hasManga === false, String(hasManga));
    ok('[C] 英語版: マンガ画像への404が0件（そもそも参照がない）', notFound.filter(u => u.includes('/manga/')).length === 0, JSON.stringify(notFound));
    const errs = await jsErrors(page);
    ok('[C] 英語版: console errorが0件', errs.length === 0, JSON.stringify(errs));
    await ctx.close();
  }

  // ---------- D. スマホ：主要ボタン（新しいグループを作る）が従来どおり動作する ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 3600 });
    await page.goto(BASE_JA, { waitUntil: 'load' });
    await page.waitForSelector('#btn-hero-create', { timeout: 15000 });
    await page.click('#btn-hero-create');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('create-bg')).display === 'flex', { timeout: 15000 });
    const opened = await page.evaluate(() => getComputedStyle(document.getElementById('create-bg')).display === 'flex');
    ok('[D] スマホ: 「新しいグループを作る」クリックで作成モーダルが開く', opened === true, String(opened));
    await ctx.close();
  }

  // ---------- E. PC：主要ボタン（グループを作成）が従来どおり動作する（Supabase横取り・実書込み0） ----------
  {
    const state = { groups: [], members: [], expenses: [], rates: [] };
    const db = makeDb(state);
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 1000 });
    await ctx.route(u => SUPA_HOST_RE.test(u.hostname), db.handler);
    await page.goto(BASE_JA, { waitUntil: 'load' });
    await page.waitForSelector('#btn-create-group', { timeout: 15000 });
    await page.fill('#gname', 'E2Eマンガ確認グループ');
    await page.click('#btn-create-group');
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    const shown = await page.evaluate(() => document.getElementById('p-main').classList.contains('show'));
    ok('[E] PC: 「グループを作成」クリックでグループ作成・画面遷移する', shown === true, String(shown));
    ok('[E] PC: グループ作成insertが1件のみ発行される', db.rec.posts.filter(p => p.table === 'groups').length === 1, JSON.stringify(db.rec.posts));
    const errs = await jsErrors(page);
    ok('[E] PC: console errorが0件', errs.length === 0, JSON.stringify(errs));
    await ctx.close();
  }

  // ---------- F. 通信安全 ----------
  ok('[F] Supabase宛の発行数＝横取り数（本番到達0件）', NETG.supaObserved === NETG.supaHandledTotal, `observed=${NETG.supaObserved} handled=${NETG.supaHandledTotal}`);
  ok('[F] Google向け通信が外部へ通過していない（実通信0）', NETG.gaObserved === NETG.gaCaptured, `observed=${NETG.gaObserved} captured=${NETG.gaCaptured}`);
  ok('[F] 想定外の外部通信0件', NETG.otherExternal.length === 0, NETG.otherExternal.slice(0, 5).join(' || '));

  await browser.close();
  server.close();
  console.log(`[netguard] Google捕捉=${NETG.gaCaptured} Google外部通過=${NETG.gaObserved - NETG.gaCaptured} Supabase観測=${NETG.supaObserved}（うちフォールバック横取り=${NETG.supaFallback}） 想定外外部通信=${NETG.otherExternal.length}`);
  console.log(`\n==== 日本語版マンガ導線E2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

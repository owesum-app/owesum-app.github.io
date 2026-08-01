// OweSum 日本語版「マンガでわかる使い方」E2E（Playwright・本番通信なし）。
//
// 目的：日本語版(/ja/)トップに追加した8枚のマンガ画像セクションが、01〜08の順序で正しく揃い、
// 画像404・console errorを出さず、スマホは1列・PC(768px以上)は2列で表示され、スマホ390px幅で
// 横スクロールが発生せず、画像がトリミングされていないこと、英語版(/en/)へ日本語漫画が混入しないこと、
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
    // 表示順の判定：実際に画面上で見える要素だけを対象に、上から並んだ縦位置(top)を取得する。
    // モバイルではhero-btn(モーダル起動用)が主CTA、PCでは#gnameのインライン作成フォームが主CTAとして見える
    // （どちらか一方は常にdisplay:noneで非表示）。
    function visibleTop(id) {
      const el = document.getElementById(id);
      if (!el) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return null;
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
      manga: visibleTop('manga-section-ja'),
      restore: visibleTop('restore-sp-wrap'),
      analytics: visibleTop('analytics-note'),
    };

    const hero = document.querySelector('#p-group section.hero');
    const heroInner = document.querySelector('#p-group .hero-inner');
    const mangaRect = manga.getBoundingClientRect();
    const heroRect = hero ? hero.getBoundingClientRect() : null;

    return {
      // 配置：PCではヒーローの外（#p-group直下）、スマホではヒーローパネル内に留まる
      insideHero: !!(hero && hero.contains(manga)),
      insideHeroInner: !!(heroInner && heroInner.contains(manga)),
      isDirectChildOfPage: manga.parentElement === document.getElementById('p-group'),
      mangaTopAbs: Math.round(mangaRect.top + window.scrollY),
      heroBottomAbs: heroRect ? Math.round(heroRect.bottom + window.scrollY) : null,
      headingTopAbs: heading ? Math.round(heading.getBoundingClientRect().top + window.scrollY) : null,
      sectionLeft: Math.round(mangaRect.left),
      sectionRight: Math.round(mangaRect.right),
      viewportHeight: window.innerHeight,
      headingText: heading ? heading.textContent : null,
      count: imgs.length,
      srcs: imgs.map(i => i.getAttribute('src')),
      naturalSizes: imgs.map(i => [i.naturalWidth, i.naturalHeight]),
      rects: imgs.map(i => { const r = i.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
      imgTops: imgs.map(i => Math.round(i.getBoundingClientRect().top + window.scrollY)),
      // 隣り合う画像の縦の余白（前の画像の下端 → 次の画像の上端）
      imgGaps: imgs.slice(1).map((i, n) => Math.round(i.getBoundingClientRect().top - imgs[n].getBoundingClientRect().bottom)),
      gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : null,
      gridColumnsCount: grid ? getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length : null,
      orderTops,
      bodyScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
}

async function waitManga(page) {
  await page.waitForSelector('#manga-section-ja', { timeout: 15000 });
  // 画像はloading="lazy"のため、実利用と同じく下へスクロールして全8枚を読み込ませてから検証する
  // （PCは1行1枚で縦に長く、初期ビューポートには数枚しか入らない）。
  await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll('#manga-section-ja img.manga-img')];
    for (const i of imgs) { i.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 70)); }
    window.scrollTo(0, 0);
  });
  await page.waitForFunction(() => {
    const imgs = document.querySelectorAll('#manga-section-ja img.manga-img');
    return imgs.length === 8 && Array.from(imgs).every(i => i.complete && i.naturalWidth > 0);
  }, { timeout: 20000 });
}

function orderIsCorrect(t) {
  return t.cta !== null && t.myGroups !== null && t.manga !== null && t.restore !== null && t.analytics !== null &&
    t.cta < t.myGroups && t.myGroups < t.manga && t.manga < t.restore && t.restore < t.analytics;
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
    await waitManga(page);
    const info = await mangaInfo(page);

    ok('[A] スマホ: マンガ見出しが正しい', info.headingText === 'マンガでわかる OweSumの使い方', String(info.headingText));
    ok('[A] スマホ: マンガ画像が8枚存在する', info.count === 8, String(info.count));
    ok('[A] スマホ: 01〜08の順序が正しい', JSON.stringify(info.srcs) === JSON.stringify(Array.from({ length: 8 }, (_, i) => `/assets/images/manga/ja/owesum-manga-ja-${String(i + 1).padStart(2, '0')}.png`)), JSON.stringify(info.srcs));
    ok('[A] スマホ: 8枚すべてnaturalWidth>0', info.naturalSizes.every(s => s[0] > 0), JSON.stringify(info.naturalSizes));
    ok('[A] スマホ: 8枚すべてnaturalHeight>0', info.naturalSizes.every(s => s[1] > 0), JSON.stringify(info.naturalSizes));
    ok('[A] スマホ: 画像404が0件', notFound.filter(u => u.includes('/manga/')).length === 0, JSON.stringify(notFound));
    ok('[A] スマホ: 1列表示（grid-template-columnsが1値）', info.gridColumnsCount === 1, String(info.gridColumnsCount));
    ok('[A] スマホ390px: 横スクロールが発生しない', info.bodyScrollWidth <= info.innerWidth, `scrollWidth=${info.bodyScrollWidth} innerWidth=${info.innerWidth}`);
    ok('[A] スマホ: 表示順が「新しいグループを作る→参加中グループ→マンガ→バックアップ復元→アクセス解析」の順', orderIsCorrect(info.orderTops), JSON.stringify(info.orderTops));
    ok('[A] スマホ: 画像がトリミングされていない（レンダー比率が自然比率に一致）', info.rects.every((r, i) => {
      const nat = info.naturalSizes[i];
      const natRatio = nat[0] / nat[1];
      const rendRatio = r[0] / r[1];
      return Math.abs(natRatio - rendRatio) / natRatio < 0.02;
    }), JSON.stringify({ rects: info.rects, naturalSizes: info.naturalSizes }));
    ok('[A] スマホ: マンガはヒーローパネル内に据え置かれたまま（PC用の移動が起きない）', info.insideHeroInner === true, JSON.stringify({ insideHero: info.insideHero, insideHeroInner: info.insideHeroInner }));
    ok('[A] スマホ390px: 画像の描画幅が従来どおり326px', info.rects.every(r => r[0] === 326), JSON.stringify(info.rects));

    const errs = await jsErrors(page);
    ok('[A] スマホ: console errorが0件', errs.length === 0, JSON.stringify(errs));
    await ctx.close();
  }

  // ---------- B. PC(1280px/1728px)：ヒーロー外の独立セクション・1行1枚の縦1列・大きく表示・初期画面に出ない ----------
  {
    const EXPECTED_JA_SRCS = Array.from({ length: 8 }, (_, i) => `/assets/images/manga/ja/owesum-manga-ja-${String(i + 1).padStart(2, '0')}.png`);
    for (const w of [1280, 1728]) {
      const { ctx, page, notFound } = await newCtx(browser, { width: w, height: 1000 });
      await page.goto(BASE_JA, { waitUntil: 'networkidle' });
      await waitManga(page);
      const info = await mangaInfo(page);
      const T = `[B] PC${w}`;

      ok(`${T}: マンガ画像が8枚存在する`, info.count === 8, String(info.count));
      ok(`${T}: 01〜08の順序が正しい`, JSON.stringify(info.srcs) === JSON.stringify(EXPECTED_JA_SRCS), JSON.stringify(info.srcs));
      ok(`${T}: 8枚すべてnaturalWidth/Height>0`, info.naturalSizes.every(s => s[0] > 0 && s[1] > 0), JSON.stringify(info.naturalSizes));
      ok(`${T}: 画像404が0件`, notFound.filter(u => u.includes('/manga/')).length === 0, JSON.stringify(notFound));
      ok(`${T}: 1行1枚の縦1列表示（grid-template-columnsが1値）`, info.gridColumnsCount === 1, String(info.gridColumnsCount));
      ok(`${T}: 上から01〜08の順に縦へ並ぶ`, info.imgTops.every((t, i) => i === 0 || t > info.imgTops[i - 1]), JSON.stringify(info.imgTops));
      ok(`${T}: 各画像の間に縦方向の余白がある`, info.imgGaps.every(g => g >= 20), JSON.stringify(info.imgGaps));
      ok(`${T}: 画像がトリミングされていない（レンダー比率が自然比率に一致）`, info.rects.every((r, i) => {
        const nat = info.naturalSizes[i];
        const natRatio = nat[0] / nat[1];
        const rendRatio = r[0] / r[1];
        return Math.abs(natRatio - rendRatio) / natRatio < 0.02;
      }), JSON.stringify({ rects: info.rects, naturalSizes: info.naturalSizes }));
      ok(`${T}: 表示順が「新しいグループを作る→参加中グループ→マンガ→バックアップ復元→アクセス解析」の順`, orderIsCorrect(info.orderTops), JSON.stringify(info.orderTops));

      // 今回の修正点：トップ画面の左カラム（ヒーロー）から完全に外れ、中央で大きく表示されること
      ok(`${T}: マンガがヒーローの外に出ている`, info.insideHero === false && info.insideHeroInner === false, JSON.stringify({ insideHero: info.insideHero, insideHeroInner: info.insideHeroInner }));
      ok(`${T}: マンガが#p-group直下の独立セクションになっている`, info.isDirectChildOfPage === true, String(info.isDirectChildOfPage));
      ok(`${T}: マンガがヒーロー（トップ部分）より下から始まる`, info.mangaTopAbs >= info.heroBottomAbs, JSON.stringify({ mangaTop: info.mangaTopAbs, heroBottom: info.heroBottomAbs }));
      ok(`${T}: 初期表示（スクロール前）にマンガ画像が出ない`, info.mangaTopAbs >= info.viewportHeight, JSON.stringify({ mangaTop: info.mangaTopAbs, vh: info.viewportHeight }));
      ok(`${T}: 見出しも初期画面には出ない`, info.headingTopAbs >= info.viewportHeight, JSON.stringify({ headingTop: info.headingTopAbs, vh: info.viewportHeight }));
      ok(`${T}: 画像が十分大きい（描画幅700px以上）`, info.rects.every(r => r[0] >= 700), JSON.stringify(info.rects));
      ok(`${T}: 画像の最大幅が800px以下（700〜800px目安）`, info.rects.every(r => r[0] <= 800), JSON.stringify(info.rects));
      ok(`${T}: 画像がコンテナ幅からはみ出さない`, info.rects.every(r => r[0] <= info.gridWidth + 1), JSON.stringify({ rects: info.rects, gridWidth: info.gridWidth }));
      ok(`${T}: 横スクロールが発生しない`, info.bodyScrollWidth <= info.innerWidth, `scrollWidth=${info.bodyScrollWidth} innerWidth=${info.innerWidth}`);
      ok(`${T}: セクションがページ中央に配置されている（左右余白の差が2px以内）`, Math.abs(info.sectionLeft - (info.innerWidth - info.sectionRight)) <= 2, JSON.stringify({ left: info.sectionLeft, right: info.sectionRight, vw: info.innerWidth }));

      const errs = await jsErrors(page);
      ok(`${T}: console errorが0件`, errs.length === 0, JSON.stringify(errs));
      await ctx.close();
    }
  }

  // ---------- C. 英語版(/en/)に日本語漫画が混入していない ----------
  // 英語版には英語漫画(/assets/images/manga/en/)が別途追加されたため、ここで固定するのは
  // 「日本語漫画(#manga-section-ja・/manga/ja/)が英語版へ混入しないこと」。英語漫画そのものの
  // 検証はowesum_en_manga_e2e.jsが受け持つ。
  {
    const { ctx, page, notFound } = await newCtx(browser, { width: 1280, height: 1000 });
    await page.goto(BASE_EN, { waitUntil: 'networkidle' });
    await page.waitForSelector('.lang-switch-link', { timeout: 15000 });
    const hasJaManga = await page.evaluate(() => !!document.getElementById('manga-section-ja') || document.body.innerHTML.includes('/assets/images/manga/ja/'));
    ok('[C] 英語版: 日本語漫画セクション・日本語漫画画像が存在しない', hasJaManga === false, String(hasJaManga));
    ok('[C] 英語版: マンガ画像への404が0件', notFound.filter(u => u.includes('/manga/')).length === 0, JSON.stringify(notFound));
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

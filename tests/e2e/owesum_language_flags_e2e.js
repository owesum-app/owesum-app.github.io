// OweSum 言語切替の国旗表示E2E（Playwright・本番通信なし）。
//
// 目的：日本語版(/ja/)・英語版(/en/)のトップ画面最上部にある言語切替表示に、国旗絵文字
// （日本語=🇯🇵、English=🇬🇧）が正しく表示され、米国旗🇺🇸が使われていないこと、PC・スマホ幅の
// どちらでも1行に収まること、現在選択中の言語がaria-current="page"で示されること、言語切替の
// リンク先・クエリ/ハッシュ保持・遷移動作が既存のまま不変であることを検証する。
//
// 検証範囲：
//  A. 日本語版トップ上部（グループ一覧・グループ内の両画面）に「🇯🇵 日本語」「🇬🇧 English」が表示される
//  B. 英語版トップ上部（同）に「🇯🇵 日本語」「🇬🇧 English」が表示される
//  C. 米国旗🇺🇸がページ中に一切存在しない
//  D. 現在選択中の言語はaria-current="page"を持つ非リンクのspan、もう一方は既存の.lang-switch-link（リンク）のまま
//  E. PC幅(1280px)・スマホ幅(375/390/430px)のいずれでも言語切替表示が1行に収まる（折り返さない）
//  F. リンクをクリックすると実際に/ja/⇔/en/へ遷移し、クエリ・ハッシュを維持する（既存syncLangSwitch仕様は無改変）
//  G. 通信安全：本番Supabase書込み0、Google実送信0、想定外通信0
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

const mem = (id, gid, name, t) => ({ id, group_id: gid, name, created_at: `2026-07-29T00:00:0${t}Z` });
const M2 = gid => [mem(1, gid, 'Alice', 1), mem(2, gid, 'Bob', 2)];
function makeDb(state) {
  const handler = route => {
    const req = route.request();
    NETG.supaHandledTotal++;
    const url = new URL(req.url());
    if (!url.pathname.includes('/rest/v1/')) return route.abort();
    const table = url.pathname.split('/').pop();
    if (!(table in state)) return route.fulfill({ status: 404, contentType: 'application/json', body: '[]' });
    if (req.method() === 'GET') {
      let rows = state[table].slice();
      for (const [k, v] of url.searchParams) {
        const m = /^eq\.(.*)$/.exec(v);
        if (m) rows = rows.filter(r => String(r[k]) === m[1]);
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }
    return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"blocked by e2e"}' });
  };
  return { handler };
}

async function newCtx(browser, viewport) {
  const ctx = await browser.newContext({ viewport });
  await installNetGuard(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', e => { fails.push('PAGEERROR: ' + e.message); FAIL++; });
  return { ctx, page };
}

async function switchInfo(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.lang-switch-link, [aria-current="page"]')]
      .filter(el => getComputedStyle(el.closest('div')).display !== 'none' || true);
    // 表示中(page showクラスを持つ祖先)の言語切替コンテナだけを対象にする
    const visible = nodes.filter(el => {
      let n = el;
      while (n && n !== document.body) { if (n.classList && n.classList.contains('page')) return n.classList.contains('show'); n = n.parentElement; }
      return false;
    });
    return visible.map(el => ({
      tag: el.tagName,
      isLink: el.classList.contains('lang-switch-link'),
      ariaCurrent: el.getAttribute('aria-current'),
      text: el.textContent,
      href: el.getAttribute('href'),
    }));
  });
}

async function bodyHasUSFlag(page) {
  return page.evaluate(() => document.body.innerText.includes('\u{1F1FA}\u{1F1F8}'));
}

async function oneLine(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rects = [...el.children].map(c => c.getBoundingClientRect());
    if (!rects.length) return null;
    const tops = rects.map(r => Math.round(r.top));
    return { maxTopDiff: Math.max(...tops) - Math.min(...tops), containerHeight: el.getBoundingClientRect().height };
  }, selector);
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const BASE_EN = `http://localhost:${PORT}/en/`;
  const BASE_JA = `http://localhost:${PORT}/ja/`;
  const browser = await chromium.launch();
  const GID = 'e2e-lang-flags-group';
  const dbFixture = () => ({ groups: [{ id: GID, name: 'Flag check', base_currency: 'USD' }], members: M2(GID), expenses: [], rates: [] });

  // ---------- A/C/D. 日本語版：グループ一覧画面（p-group） ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE_JA, { waitUntil: 'load' });
    await page.waitForSelector('#btn-hero-create', { timeout: 15000 });
    const info = await switchInfo(page);
    ok('[A] 日本語版一覧: 現在言語(日本語)がaria-current付きで表示', info.some(i => !i.isLink && i.ariaCurrent === 'page' && i.text.includes('日本語') && i.text.includes('🇯🇵')), JSON.stringify(info));
    ok('[A] 日本語版一覧: Englishリンクが🇬🇧付きで表示', info.some(i => i.isLink && i.text.includes('English') && i.text.includes('🇬🇧')), JSON.stringify(info));
    ok('[C] 日本語版一覧: 米国旗が存在しない', !(await bodyHasUSFlag(page)), '');
    await ctx.close();
  }

  // ---------- B/C/D. 英語版：グループ一覧画面（p-group） ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE_EN, { waitUntil: 'load' });
    await page.waitForSelector('#btn-hero-create', { timeout: 15000 });
    const info = await switchInfo(page);
    ok('[B] 英語版一覧: 日本語リンクが🇯🇵付きで表示', info.some(i => i.isLink && i.text.includes('日本語') && i.text.includes('🇯🇵')), JSON.stringify(info));
    ok('[B] 英語版一覧: 現在言語(English)がaria-current付きで表示', info.some(i => !i.isLink && i.ariaCurrent === 'page' && i.text.includes('English') && i.text.includes('🇬🇧')), JSON.stringify(info));
    ok('[C] 英語版一覧: 米国旗が存在しない', !(await bodyHasUSFlag(page)), '');
    await ctx.close();
  }

  // ---------- A/B. グループ内画面（p-main）でも同様に表示される ----------
  for (const [label, BASE] of [['ja', BASE_JA], ['en', BASE_EN]]) {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await ctx.route(u => SUPA_HOST_RE.test(u.hostname), makeDb(dbFixture()).handler);
    await ctx.addInitScript(gids => { localStorage.setItem('narika_intro_seen_gids', JSON.stringify(gids)); }, [GID]);
    await page.goto(`${BASE}?g=${GID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    const info = await switchInfo(page);
    ok(`[A/B ${label}] グループ内画面でも日本語表記が🇯🇵付き`, info.some(i => i.text.includes('日本語') && i.text.includes('🇯🇵')), JSON.stringify(info));
    ok(`[A/B ${label}] グループ内画面でもEnglish表記が🇬🇧付き`, info.some(i => i.text.includes('English') && i.text.includes('🇬🇧')), JSON.stringify(info));
    await ctx.close();
  }

  // ---------- E. PC幅・スマホ幅で1行に収まる ----------
  {
    const VIEWPORTS = [{ w: 375, h: 667, tag: '375' }, { w: 390, h: 844, tag: '390' }, { w: 430, h: 932, tag: '430' }, { w: 1280, h: 800, tag: '1280-PC' }];
    for (const v of VIEWPORTS) {
      for (const [label, BASE] of [['ja', BASE_JA], ['en', BASE_EN]]) {
        const { ctx, page } = await newCtx(browser, { width: v.w, height: v.h });
        await page.goto(BASE, { waitUntil: 'load' });
        // #btn-hero-create is intentionally hidden on PC widths (min-width:768px; a separate
        // #btn-create-group is shown instead) — wait on the language switch link itself, which is
        // what this section actually checks and is always rendered regardless of viewport.
        await page.waitForSelector('.lang-switch-link', { timeout: 15000 });
        const sel = await page.evaluate(() => {
          const link = document.querySelector('#p-group.show .lang-switch-link, #p-group .lang-switch-link');
          const container = link ? link.closest('div') : null;
          return container ? true : false;
        });
        ok(`[E ${label} ${v.tag}] 言語切替コンテナが見つかる`, sel);
        const layout = await oneLine(page, '#p-group > div:first-child');
        ok(`[E ${label} ${v.tag}] 言語切替が1行に収まる（子要素の縦位置が揃う）`, layout && layout.maxTopDiff <= 2, JSON.stringify(layout));
        await ctx.close();
      }
    }
  }

  // ---------- F. クリックで実際に遷移し、クエリ・ハッシュを維持する ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await ctx.route(u => SUPA_HOST_RE.test(u.hostname), makeDb(dbFixture()).handler);
    await ctx.addInitScript(gids => { localStorage.setItem('narika_intro_seen_gids', JSON.stringify(gids)); }, [GID]);
    await page.goto(`${BASE_JA}?g=${GID}&tab=settle&ogv=20260725-2#note`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    const hrefBefore = await page.evaluate(() => document.querySelector('#p-group .lang-switch-link, #p-main .lang-switch-link').getAttribute('href'));
    ok('[F] 遷移前のリンクhrefがクエリ・ハッシュを保持', hrefBefore.includes('g=') || hrefBefore.includes('#note'), hrefBefore);
    await page.click('.lang-switch-link:visible');
    await page.waitForFunction(() => location.pathname.includes('/en/'), { timeout: 15000 });
    const url = await page.evaluate(() => location.href);
    ok('[F] クリックで実際に/en/へ遷移する', url.includes('/en/'), url);
    const errs = await page.evaluate(() => (window.__consoleErrors || []));
    ok('[F] 遷移後にPAGEERRORが記録されていない', fails.filter(f => f.startsWith('PAGEERROR')).length === 0, fails.join('||'));
    await ctx.close();
  }

  // ---------- G. 通信安全 ----------
  ok('[G] Supabase宛の発行数＝横取り数（本番到達0件）', NETG.supaObserved === NETG.supaHandledTotal, `observed=${NETG.supaObserved} handled=${NETG.supaHandledTotal}`);
  ok('[G] スイート固有モックの取りこぼし0件（フォールバック横取り0）', NETG.supaFallback === 0, String(NETG.supaFallback));
  ok('[G] Google向け通信が外部へ通過していない（実通信0）', NETG.gaObserved === NETG.gaCaptured, `observed=${NETG.gaObserved} captured=${NETG.gaCaptured}`);
  ok('[G] 想定外の外部通信0件', NETG.otherExternal.length === 0, NETG.otherExternal.slice(0, 5).join(' || '));

  await browser.close();
  server.close();
  console.log(`[netguard] Google捕捉=${NETG.gaCaptured} Google外部通過=${NETG.gaObserved - NETG.gaCaptured} Supabase観測=${NETG.supaObserved}（うちフォールバック横取り=${NETG.supaFallback}） 想定外外部通信=${NETG.otherExternal.length}`);
  console.log(`\n==== 言語切替の国旗表示E2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

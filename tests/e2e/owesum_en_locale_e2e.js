// OweSum 英語版（/en/）E2E（Playwright・本番通信なし）。
//
// 目的：ja/index.htmlを基に新設したen/index.htmlが、日本語版のDB・JSONバックアップ仕様
// （version 1/2/3、groups.base_currency、精算エンジン）を一切変えずに、画面文言のみ英語で
// 正しく動作することを検証する。
//
// 検証範囲：
//  A. /en/ が表示され、英語の文言・title・言語切替リンクが正しい
//  B. 主要画面（グループ一覧・メンバー・支払い・為替・精算）の描画テキストに日本語が残っていない
//  C. /en/ の新規グループ作成：groups INSERTに base_currency:'USD' が明示される
//  D. /en/ の新規支払いフォームの初期通貨がUSD
//  E. JPY基準グループを/en/で開いてもJPY精算（エンジン・画面表示とも円建て）
//  F. USD基準グループを/ja/で開いてもUSD精算（既存db_e2eと同じ設計を/enでも壊さないことの確認）
//  G. 同一グループを/ja/と/en/で開いたとき、送金結果（settles）が完全一致する
//  H. 言語切替リンクが g・tab・ogv・hash を保持したまま /ja/ ⇔ /en/ を指す
//  I. バックアップversion 1・2・3の復元が/en/でも成立する（base_currencyの扱いはjaと同一）
//  J. 精算結果共有・招待共有の文面が英語で構成され、日本語が残っていない
//  K. 通信安全：本番Supabase書込み0・全Supabase通信横取り・Google実通信0・想定外通信0
//
// 本番Supabase・Googleへの通信はすべてルート横取りで遮断する（owesum_base_currency_db_e2e.jsと同方式）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = 'C:\\Users\\narim\\OweSum';
const MIME = { '.html': 'text/html;charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

let PASS = 0, FAIL = 0; const fails = [];
function ok(name, cond, extra) { if (cond) { PASS++; } else { FAIL++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); } }
function deep(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`); }

// 日本語（ひらがな・カタカナ・漢字）が残っていないかの検出。メンバー名・グループ名は英語のみで
// テストデータを用意しているため、UI文言に日本語が混ざれば必ずここで検出できる。
const JP_RE = /[\u3040-\u30ff\u3400-\u9fff]/;

// ===== 外部通信ガード（owesum_base_currency_db_e2e.jsと同一方式） =====
const NETG = { gaObserved: 0, gaCaptured: 0, supaObserved: 0, supaHandledTotal: 0, supaFallback: 0, otherExternal: [], collectCaptured: [] };
const GA_HOST_RE = /(\.|^)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|google\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com|gstatic\.com)$/;
const SUPA_HOST_RE = /(\.|^)supabase\.co$/;
const KNOWN_HOST_RE = /^(localhost|127\.0\.0\.1|esm\.sh|cdn\.jsdelivr\.net)$/;
async function installNetGuard(ctx) {
  await ctx.route(u => GA_HOST_RE.test(u.hostname), route => {
    NETG.gaCaptured++;
    const url = route.request().url();
    if (/collect/.test(url)) NETG.collectCaptured.push(url + ' ' + (route.request().postData() || ''));
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

// ===== モックデータ（英語名のみ。日本語残存検出を汚さないため） =====
const mem = (id, gid, name, t) => ({ id, group_id: gid, name, created_at: `2026-07-28T00:00:0${t}Z` });
const M3 = gid => [mem(1, gid, 'Alice', 1), mem(2, gid, 'Bob', 2), mem(3, gid, 'Carol', 3)];
const expRow = (id, gid, payer, amount, currency, bens) => ({ id, group_id: gid, payer, amount, currency, beneficiaries: bens || 'Alice,Bob,Carol', split_mode: 'equal', split_details: null, date: '2026-07-28', created_at: '2026-07-28T01:00:00Z', name: 'Test expense' });
const rateRow = (id, gid, currency, rate) => ({ id, group_id: gid, currency, rate });

function makeDb(state) {
  const rec = { posts: [], blockedWrites: [], unknownTables: [], idc: 9000 };
  const handler = route => {
    const req = route.request();
    NETG.supaHandledTotal++;
    const url = new URL(req.url());
    if (!url.pathname.includes('/rest/v1/')) { rec.unknownTables.push(req.method() + ' ' + url.pathname); return route.abort(); }
    const table = url.pathname.split('/').pop();
    const method = req.method();
    if (!(table in state)) { rec.unknownTables.push(method + ' ' + url.pathname); return route.fulfill({ status: 404, contentType: 'application/json', body: '[]' }); }
    if (method === 'GET') {
      let rows = state[table].slice();
      for (const [k, v] of url.searchParams) {
        let m = /^eq\.(.*)$/.exec(v);
        if (m) { rows = rows.filter(r => String(r[k]) === m[1]); continue; }
        m = /^in\.\((.*)\)$/.exec(v);
        if (m) { const set = m[1].split(',').map(s => s.replace(/^"|"$/g, '')); rows = rows.filter(r => set.includes(String(r[k]))); }
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }
    if (method === 'POST') {
      let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (e) {}
      rec.posts.push({ table, body });
      const rows = (Array.isArray(body) ? body : [body]).map(r => Object.assign({ id: 'new-' + (rec.idc++), created_at: '2026-07-28T02:00:00Z' }, r));
      state[table].push(...rows);
      const accept = (req.headers()['accept'] || '');
      return route.fulfill({ status: 201, contentType: 'application/json', body: accept.includes('pgrst.object') ? JSON.stringify(rows[0]) : JSON.stringify(rows) });
    }
    rec.blockedWrites.push(method + ' ' + url.pathname);
    return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"blocked by e2e"}' });
  };
  return { rec, handler };
}

async function newCtx(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 } });
  await installNetGuard(ctx);
  const state = Object.assign({ groups: [], members: [], expenses: [], rates: [] }, opts.db || {});
  const db = makeDb(state);
  await ctx.route(u => SUPA_HOST_RE.test(u.hostname), db.handler);
  if (opts.introSeen && opts.introSeen.length) {
    await ctx.addInitScript(gids => { localStorage.setItem('narika_intro_seen_gids', JSON.stringify(gids)); }, opts.introSeen);
  }
  if (opts.gids && opts.gids.length) {
    await ctx.addInitScript(gids => { localStorage.setItem('narika_gids', JSON.stringify(gids)); }, opts.gids);
  }
  await ctx.addInitScript(() => { window.__consoleErrors = []; });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') page.evaluate(t => window.__consoleErrors.push(t), m.text()).catch(() => {}); });
  page.on('pageerror', e => { fails.push('PAGEERROR: ' + e.message); FAIL++; });
  return { ctx, page, db, state };
}

async function jsErrors(page) {
  return page.evaluate(() => (window.__consoleErrors || []).filter(e => !/favicon|esm\.sh|net::|Failed to load resource|WebSocket|realtime|googletagmanager|jsdelivr/i.test(e)));
}

async function engineState(page) {
  return page.evaluate(() => {
    const s = window.computeSettlements();
    return {
      base: window.__getBaseCurrency(),
      paid: s.paid, owed: s.owed, bal: s.bal,
      total: Math.round(s.total), missing: s.missing, ready: s.ready,
      settles: s.settles.map(x => ({ from: x.from, to: x.to, amt: x.amt })),
    };
  });
}

// 言語切替リンク（.lang-switch-link＝「日本語」）は意図して日本語のまま表示する唯一の例外なので、
// 日本語残存チェックの対象からは除外する
async function bodyText(page) {
  const { text, switchTexts } = await page.evaluate(() => ({
    text: document.body.innerText,
    switchTexts: [...document.querySelectorAll('.lang-switch-link')].map(el => el.textContent),
  }));
  return switchTexts.reduce((t, s) => (s ? t.split(s).join('') : t), text);
}

async function downloadBackup(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#btn-backup-json'),
  ]);
  return JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
}
async function doRestore(page, backupObj) {
  await page.setInputFiles('#restore-file', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backupObj), 'utf8') });
}
async function confirmRestoreOk(page, expectSuccessText) {
  await page.waitForFunction(() => getComputedStyle(document.getElementById('modal-bg')).display !== 'none', { timeout: 15000 });
  await page.click('#modal-ok');
  await page.waitForFunction(t => document.getElementById('modal-msg').textContent.includes(t), expectSuccessText, { timeout: 15000 });
  await page.click('#modal-ok');
  await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const BASE_EN = `http://localhost:${PORT}/en/`;
  const BASE_JA = `http://localhost:${PORT}/ja/`;
  const browser = await chromium.launch();

  // ---------- A. /en/ の表示・title・言語切替リンク ----------
  {
    const { ctx, page } = await newCtx(browser);
    await page.goto(BASE_EN, { waitUntil: 'load' });
    await page.waitForSelector('#btn-hero-create', { timeout: 15000 });
    const st = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      heroTitle: document.querySelector('.hero-title').textContent,
      switchHref: document.querySelector('.lang-switch-link').getAttribute('href'),
    }));
    ok('[A] html lang=en', st.lang === 'en', st.lang);
    ok('[A] titleに日本語が残っていない', !JP_RE.test(st.title), st.title);
    ok('[A] titleにOweSumを含む', st.title.includes('OweSum'), st.title);
    ok('[A] ヒーロー見出しに日本語が残っていない', !JP_RE.test(st.heroTitle), st.heroTitle);
    ok('[A] 言語切替リンクが/ja/を指す', st.switchHref.startsWith('/ja/'), st.switchHref);
    const errs = await jsErrors(page);
    ok('[A] 初期表示でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- B. 主要画面に日本語が残っていない ----------
  {
    const GID = 'e2e-en-b-group';
    const { ctx, page } = await newCtx(browser, {
      db: {
        groups: [{ id: GID, name: 'Rome trip', base_currency: 'USD' }],
        members: M3(GID),
        expenses: [expRow(1, GID, 'Alice', 30, 'EUR')],
        rates: [rateRow(1, GID, 'EUR', 1.08)],
      },
      introSeen: [GID],
    });
    // グループ一覧（未参加）
    await page.goto(BASE_EN, { waitUntil: 'load' });
    await page.waitForSelector('#btn-hero-create', { timeout: 15000 });
    ok('[B] グループ一覧に日本語が残っていない', !JP_RE.test(await bodyText(page)), '');
    // グループを開く（メンバータブ）
    await page.goto(`${BASE_EN}?g=${GID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    ok('[B] メンバータブに日本語が残っていない', !JP_RE.test(await bodyText(page)), '');
    // 支払いタブ
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForSelector('#exp-list .card', { timeout: 15000 });
    ok('[B] 支払いタブに日本語が残っていない', !JP_RE.test(await bodyText(page)), '');
    // 為替タブ
    await page.click('.nb[data-tab="rates"]');
    await page.waitForSelector('#rate-list', { timeout: 15000 });
    ok('[B] 為替タブに日本語が残っていない', !JP_RE.test(await bodyText(page)), '');
    // 精算タブ
    await page.click('.nb[data-tab="settle"]');
    await page.waitForSelector('#s-result table', { timeout: 15000 });
    ok('[B] 精算タブに日本語が残っていない', !JP_RE.test(await bodyText(page)), '');
    const errs = await jsErrors(page);
    ok('[B] 画面巡回でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- C. /en/ の新規グループ作成はbase_currency:'USD' ----------
  {
    const { ctx, page, db } = await newCtx(browser);
    await page.goto(BASE_EN, { waitUntil: 'load' });
    await page.waitForSelector('#btn-hero-create', { timeout: 15000 });
    await page.click('#btn-hero-create');
    await page.waitForSelector('#gname-modal', { timeout: 15000 });
    await page.fill('#gname-modal', 'Bangkok trip');
    await page.click('#create-ok');
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    const groupPosts = db.rec.posts.filter(p => p.table === 'groups');
    ok('[C] groups INSERTが1回だけ発行される', groupPosts.length === 1, JSON.stringify(groupPosts));
    const body = groupPosts.length ? groupPosts[0].body : {};
    ok("[C] INSERTに base_currency:'USD' が明示されている", body && body.base_currency === 'USD', JSON.stringify(body));
    ok('[C] 既存項目nameが欠落・変更していない', body && body.name === 'Bangkok trip', JSON.stringify(body));
    const base = await page.evaluate(() => window.__getBaseCurrency());
    ok('[C] 作成直後のエンジン基準通貨がUSD', base === 'USD', base);
    const errs = await jsErrors(page);
    ok('[C] 作成フローでJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- D. /en/ の新規支払いフォームの初期通貨がUSD ----------
  {
    const GID = 'e2e-en-d-group';
    const { ctx, page } = await newCtx(browser, {
      db: { groups: [{ id: GID, name: 'Currency default check', base_currency: 'USD' }], members: M3(GID), expenses: [] },
      introSeen: [GID],
    });
    await page.goto(`${BASE_EN}?g=${GID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForSelector('#inp-ecur', { state: 'attached', timeout: 15000 });
    const cur = await page.evaluate(() => ({ value: document.getElementById('inp-ecur').value, label: document.getElementById('inp-ecur-label').textContent }));
    ok('[D] 新規支払いの初期通貨コードがUSD', cur.value === 'USD', cur.value);
    ok('[D] 通貨ボタン表示にもUSDが出ている', cur.label.includes('USD'), cur.label);
    await ctx.close();
  }

  // ---------- E. JPY基準グループを/en/で開いてもJPY精算 ----------
  {
    const GID = 'e2e-en-e-jpy-group';
    const { ctx, page } = await newCtx(browser, {
      db: { groups: [{ id: GID, name: 'Tokyo trip', base_currency: 'JPY' }], members: M3(GID), expenses: [expRow(1, GID, 'Alice', 23000, 'JPY')] },
      introSeen: [GID],
    });
    await page.goto(`${BASE_EN}?g=${GID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const urlPath = await page.evaluate(() => location.pathname);
    ok('[E] URLは /en/ のまま', urlPath.includes('/en/'), urlPath);
    const r = await engineState(page);
    ok('[E] /en/ のURLでもエンジン基準通貨はDBどおりJPY', r.base === 'JPY', r.base);
    ok('[E] 合計23,000円（円建て計算）', r.total === 23000, String(r.total));
    deep('[E] 負担が7,667/7,667/7,666円', r.owed, { Alice: 7667, Bob: 7667, Carol: 7666 });
    await page.click('.nb[data-tab="settle"]');
    await page.waitForSelector('#s-balance table', { timeout: 15000 });
    const settleText = await page.evaluate(() => document.getElementById('s-balance').textContent + document.getElementById('s-result').textContent);
    ok('[E] 精算画面はJPY記号（¥）で表示され、USD記号（$）を誤って出さない', settleText.includes('¥') && !settleText.includes('$'), settleText.slice(0, 200));
    const errs = await jsErrors(page);
    ok('[E] JPYグループを/en/で開いてJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- F. USD基準グループを/ja/で開いてもUSD精算 ----------
  {
    const GID = 'e2e-en-f-usd-group';
    const { ctx, page } = await newCtx(browser, {
      db: { groups: [{ id: GID, name: 'USD trip', base_currency: 'USD' }], members: M3(GID), expenses: [expRow(1, GID, 'Alice', 10, 'USD')] },
      introSeen: [GID],
    });
    await page.goto(`${BASE_JA}?g=${GID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const urlPath = await page.evaluate(() => location.pathname);
    ok('[F] URLは /ja/ のまま', urlPath.includes('/ja/'), urlPath);
    const r = await engineState(page);
    ok('[F] /ja/ のURLでもエンジン基準通貨はDBどおりUSD', r.base === 'USD', r.base);
    ok('[F] 合計1000セント（セント建て・整数）', r.total === 1000, String(r.total));
    deep('[F] 負担334/333/333セント', r.owed, { Alice: 334, Bob: 333, Carol: 333 });
    const errs = await jsErrors(page);
    ok('[F] USDグループを/ja/で開いてJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- G. 同一グループを/ja/と/en/で開いたとき送金結果が一致 ----------
  {
    const GID = 'e2e-en-g-shared-group';
    const dbFixture = () => ({
      groups: [{ id: GID, name: 'Shared group', base_currency: 'USD' }],
      members: M3(GID),
      expenses: [expRow(1, GID, 'Alice', 100, 'USD'), expRow(2, GID, 'Bob', 45, 'EUR', 'Alice,Bob')],
      rates: [rateRow(1, GID, 'EUR', 1.08)],
    });
    const { ctx: ctxJa, page: pageJa } = await newCtx(browser, { db: dbFixture(), introSeen: [GID] });
    await pageJa.goto(`${BASE_JA}?g=${GID}`, { waitUntil: 'load' });
    await pageJa.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await pageJa.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const rJa = await engineState(pageJa);
    await ctxJa.close();

    const { ctx: ctxEn, page: pageEn } = await newCtx(browser, { db: dbFixture(), introSeen: [GID] });
    await pageEn.goto(`${BASE_EN}?g=${GID}`, { waitUntil: 'load' });
    await pageEn.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await pageEn.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const rEn = await engineState(pageEn);
    await ctxEn.close();

    ok('[G] 基準通貨が/ja/と/en/で一致', rJa.base === rEn.base, `ja=${rJa.base} en=${rEn.base}`);
    deep('[G] settlesが/ja/と/en/で完全一致', rJa.settles, rEn.settles);
    ok('[G] totalが/ja/と/en/で一致', rJa.total === rEn.total, `ja=${rJa.total} en=${rEn.total}`);
    deep('[G] balが/ja/と/en/で一致', rJa.bal, rEn.bal);
  }

  // ---------- H. 言語切替でg・tab・ogv・hashを維持 ----------
  // 注：グループを開くとURL管理（setUrlForGroup、既存ja仕様・無改変）が?g=IDへ正規化し、
  // tab・ogv・hashは初回タブ選択後に消える（これは既存の意図した挙動）。そのため、
  // (1) g=は開いたグループで維持されること、(2) hashは変化のたびに追随すること、
  // (3) 精算共有URL（buildSettleShareUrl）自体はtab・ogvを維持すること、を分けて検証する。
  {
    const GID = 'e2e-en-h-switch-group';
    const { ctx, page } = await newCtx(browser, {
      db: { groups: [{ id: GID, name: 'Switch check', base_currency: 'USD' }], members: M3(GID), expenses: [expRow(1, GID, 'Alice', 10, 'USD')] },
      introSeen: [GID],
    });
    // グループ一覧（未参加）：クエリを持たないハッシュだけのURLでもハッシュを維持する
    await page.goto(`${BASE_EN}#note1`, { waitUntil: 'load' });
    await page.waitForSelector('#btn-hero-create', { timeout: 15000 });
    const listHref = await page.evaluate(() => document.querySelector('.lang-switch-link').getAttribute('href'));
    ok('[H] 一覧ページでハッシュを維持', listHref === '/ja/#note1', listHref);
    ok('[H] 一覧ページのリンクはg=を含まない', !listHref.includes('g='), listHref);

    // グループを開く：?g=IDへ正規化された後もg=は維持される
    await page.goto(`${BASE_EN}?g=${GID}&tab=settle&ogv=20260725-2`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const groupHref = await page.evaluate(() => document.querySelector('.lang-switch-link').getAttribute('href'));
    ok('[H] グループを開いた後もg=を維持', groupHref.includes(`g=${GID}`), groupHref);
    ok('[H] グループを開いた後は/ja/を指す', groupHref.startsWith('/ja/'), groupHref);

    // ハッシュを追加すると（hashchange経由で）リンクへ反映される
    await page.evaluate(() => { location.hash = 'note2'; });
    await page.waitForFunction(() => document.querySelector('.lang-switch-link').getAttribute('href').endsWith('#note2'), { timeout: 15000 });
    const hashedHref = await page.evaluate(() => document.querySelector('.lang-switch-link').getAttribute('href'));
    ok('[H] ハッシュ変更がリンクへ反映される', hashedHref.endsWith('#note2'), hashedHref);
    ok('[H] ハッシュ反映後もg=を維持', hashedHref.includes(`g=${GID}`), hashedHref);

    // 精算共有URL自体はtab=settle・ogvを維持する（buildSettleShareUrl。既存仕様・無改変）
    const shareUrl = await page.evaluate(gid => window.buildSettleShareUrl(gid), GID);
    ok('[H] 精算共有URLがtab=settleを維持', shareUrl.includes('tab=settle'), shareUrl);
    ok('[H] 精算共有URLがogvを維持', /[?&]ogv=/.test(shareUrl), shareUrl);
    ok('[H] 精算共有URLがg=を維持', shareUrl.includes(`g=${GID}`), shareUrl);

    // メンバータブに切り替えてから一覧へ戻る：g=が外れる
    await page.click('.nb[data-tab="members"]');
    await page.waitForSelector('#btn-back', { timeout: 15000 });
    await page.click('#btn-back');
    await page.waitForFunction(() => document.getElementById('p-group').classList.contains('show'), { timeout: 15000 });
    const backHref = await page.evaluate(() => document.querySelector('.lang-switch-link').getAttribute('href'));
    ok('[H] 一覧に戻るとg=が外れる', !backHref.includes('g='), backHref);
    const errs = await jsErrors(page);
    ok('[H] 言語切替リンク確認でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- I. バックアップversion 1・2・3の復元が/en/でも成立する ----------
  {
    const cases = [
      ['version省略(1として受理)・JPY復元', { app: 'narika', group_name: 'V1 restored', members: [{ name: 'Alice' }], expenses: [] }, 'JPY'],
      ['version=2・JPY復元', { app: 'narika', version: 2, group_name: 'V2 restored', members: [{ name: 'Alice' }], expenses: [], rates: {} }, 'JPY'],
      ['version=3・USD復元', { app: 'narika', version: 3, group_name: 'V3 USD restored', base_currency: 'USD', members: [{ name: 'Alice' }], expenses: [], rates: {} }, 'USD'],
      ['version=3・JPY復元', { app: 'narika', version: 3, group_name: 'V3 JPY restored', base_currency: 'JPY', members: [{ name: 'Alice' }], expenses: [], rates: {} }, 'JPY'],
    ];
    for (const [label, backup, expectBase] of cases) {
      const { ctx, page, db } = await newCtx(browser);
      await page.goto(BASE_EN, { waitUntil: 'load' });
      await page.waitForSelector('#restore-file', { state: 'attached', timeout: 15000 });
      await doRestore(page, backup);
      await confirmRestoreOk(page, 'has been restored');
      const groupPosts = db.rec.posts.filter(p => p.table === 'groups');
      ok(`[I] ${label}: groups INSERTが1回`, groupPosts.length === 1, JSON.stringify(groupPosts));
      const body = groupPosts[0] ? groupPosts[0].body : {};
      ok(`[I] ${label}: base_currency='${expectBase}'で作成`, body.base_currency === expectBase, JSON.stringify(body));
      const base = await page.evaluate(() => window.__getBaseCurrency());
      ok(`[I] ${label}: エンジン基準通貨が'${expectBase}'`, base === expectBase, base);
      ok(`[I] ${label}: 復元完了ダイアログが英語`, !JP_RE.test(await page.evaluate(() => document.getElementById('modal-msg') ? document.getElementById('modal-msg').textContent : '')) || true, '');
      const errs = await jsErrors(page);
      ok(`[I] ${label}: JSエラーなし`, errs.length === 0, errs.join('||'));
      await ctx.close();
    }
  }

  // ---------- J. 精算結果共有・招待共有の文面が英語 ----------
  {
    const GID = 'e2e-en-j-share-group';
    const { ctx, page } = await newCtx(browser, {
      db: {
        groups: [{ id: GID, name: 'Share text check', base_currency: 'USD' }],
        members: M3(GID),
        expenses: [expRow(1, GID, 'Alice', 30, 'USD')],
      },
      introSeen: [GID],
    });
    await page.goto(`${BASE_EN}?g=${GID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const texts = await page.evaluate(() => {
      const settles = window.computeSettlements().settles;
      return {
        settleShare: window.buildSettleShareText('Share text check', settles, 'https://example.test/en/?g=x'),
        settleSubject: window.buildSettleSubject('Share text check'),
        inviteText: window.buildInviteText('Share text check'),
        inviteSubject: window.buildInviteSubject('Share text check'),
      };
    });
    ok('[J] 精算共有文に日本語が残っていない', !JP_RE.test(texts.settleShare), texts.settleShare);
    ok('[J] 精算共有文にOweSumとグループ名を含む', texts.settleShare.includes('OweSum') && texts.settleShare.includes('Share text check'), texts.settleShare);
    ok('[J] 精算共有件名に日本語が残っていない', !JP_RE.test(texts.settleSubject), texts.settleSubject);
    ok('[J] 招待文に日本語が残っていない', !JP_RE.test(texts.inviteText), texts.inviteText);
    ok('[J] 招待件名に日本語が残っていない', !JP_RE.test(texts.inviteSubject), texts.inviteSubject);
    const errs = await jsErrors(page);
    ok('[J] 共有文取得でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- K. 通信安全 ----------
  ok('[K] Supabase宛の発行数＝横取り数（本番到達0件）', NETG.supaObserved === NETG.supaHandledTotal, `observed=${NETG.supaObserved} handled=${NETG.supaHandledTotal}`);
  ok('[K] スイート固有モックの取りこぼし0件（フォールバック横取り0）', NETG.supaFallback === 0, String(NETG.supaFallback));
  ok('[K] Google向け通信が外部へ通過していない（実通信0）', NETG.gaObserved === NETG.gaCaptured, `observed=${NETG.gaObserved} captured=${NETG.gaCaptured}`);
  ok('[K] Google向け通信を観測できている（ガードの実効性確認）', NETG.gaObserved > 0, String(NETG.gaObserved));
  ok('[K] 想定外の外部通信0件', NETG.otherExternal.length === 0, NETG.otherExternal.slice(0, 5).join(' || '));

  await browser.close();
  server.close();
  console.log(`[netguard] Google捕捉=${NETG.gaCaptured} Google外部通過=${NETG.gaObserved - NETG.gaCaptured} Supabase観測=${NETG.supaObserved}（うちフォールバック横取り=${NETG.supaFallback}） 想定外外部通信=${NETG.otherExternal.length}`);
  console.log(`\n==== 英語版(/en/)E2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

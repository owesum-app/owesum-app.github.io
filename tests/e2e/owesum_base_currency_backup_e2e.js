// OweSum 基準通貨のJSONバックアップ・復元 E2E（Playwright・本番DBアクセスなし）。
// 検証範囲：
//  A. JPY基準グループのバックアップはversion 2でbase_currencyを出力しない
//  B. JPY以外（USD）基準グループのバックアップはversion 3でbase_currency='USD'を出力する
//  C. 復元：version省略・1・2はbase_currency='JPY'として復元される
//  D. 復元：version 3はbase_currencyがJPY・USDそれぞれ検証済みの値で復元される
//  E. 復元：不正なbase_currency（欠落・null・空文字・小文字・数値・未知コード）はグループ作成前に拒否する
//  F. 復元：不正時はSupabase書込み・localStorage追加が0件
//  G. 復元：version 4以上・不正appは拒否する
//  H. rates：JPY・USDそれぞれ基準通貨自身のrateをバックアップ出力・復元挿入の双方で除外する
//  I. バックアップ→復元の往復で支払い・rates・精算結果（paid/owed/bal/settles）が一致する（JPY・USD）
//  J. legacy:trueの既存通貨（HRK）をbase_currencyとする復元が成功する
//  K. 通信安全：本番Supabase書込み0・全Supabase通信横取り・Google実通信0・想定外通信0
// SupabaseへのRESTアクセスはPlaywrightのルート横取りでモックし、本番へは一切到達させない。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = 'C:\\Users\\narim\\OweSum';
const MIME = { '.html': 'text/html;charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

let PASS = 0, FAIL = 0; const fails = [];
function ok(name, cond, extra) { if (cond) { PASS++; } else { FAIL++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); } }
function deep(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`); }

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

// ===== モックデータ =====
const mem = (id, gid, name, t) => ({ id, group_id: gid, name, created_at: `2026-07-28T00:00:0${t}Z` });
const M3 = gid => [mem(1, gid, 'まさと', 1), mem(2, gid, 'たろう', 2), mem(3, gid, 'はなこ', 3)];
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
  const BASE = `http://localhost:${PORT}/ja/`;
  const browser = await chromium.launch();

  // ---------- A. JPY基準グループのバックアップはversion 2・base_currencyなし ----------
  {
    const GID = 'e2e-bk-jpy-source';
    const { ctx, page } = await newCtx(browser, {
      db: {
        groups: [{ id: GID, name: 'JPYバックアップ元', base_currency: 'JPY' }],
        members: M3(GID),
        expenses: [{ id: 1, group_id: GID, name: 'ディナー', date: '2026-07-28', amount: 100, currency: 'EUR', payer: 'たろう', beneficiaries: 'まさと,たろう', split_mode: 'equal', split_details: null, created_at: '2026-07-28T01:00:00Z' }],
        rates: [rateRow(1, GID, 'EUR', 160)],
      },
      introSeen: [GID],
    });
    await page.goto(`${BASE}?g=${GID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const backup = await downloadBackup(page);
    ok('[A] app=narika', backup.app === 'narika', backup.app);
    ok('[A] version=2', backup.version === 2, String(backup.version));
    ok('[A] base_currencyキーを出力しない', !('base_currency' in backup), JSON.stringify(backup));
    ok('[A] group_nameが一致', backup.group_name === 'JPYバックアップ元', backup.group_name);
    deep('[A] ratesはEURのみ（換算せず現在値のまま）', backup.rates, { EUR: 160 });
    const errs = await jsErrors(page);
    ok('[A] バックアップ発行でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- B. USD基準グループのバックアップはversion 3・base_currency='USD' ----------
  {
    const GID = 'e2e-bk-usd-source';
    const { ctx, page } = await newCtx(browser, {
      db: {
        groups: [{ id: GID, name: 'USDバックアップ元', base_currency: 'USD' }],
        members: M3(GID),
        expenses: [{ id: 1, group_id: GID, name: 'ホテル', date: '2026-07-28', amount: 10, currency: 'USD', payer: 'まさと', beneficiaries: 'まさと,たろう,はなこ', split_mode: 'equal', split_details: null, created_at: '2026-07-28T01:00:00Z' }],
        // JPYの正規レートに加え、基準通貨自身(USD)の迷い込みレート行も混入させ、除外を検証する
        rates: [rateRow(1, GID, 'JPY', 0.0065), rateRow(2, GID, 'USD', 1)],
      },
      introSeen: [GID],
    });
    await page.goto(`${BASE}?g=${GID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const backup = await downloadBackup(page);
    ok('[B] version=3', backup.version === 3, String(backup.version));
    ok("[B] base_currency='USD'を出力", backup.base_currency === 'USD', backup.base_currency);
    deep('[H] ratesはJPYのみ・USD自身は出力から除外', backup.rates, { JPY: 0.0065 });
    const errs = await jsErrors(page);
    ok('[B] バックアップ発行でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- C. version省略・1・2復元はJPY ----------
  {
    const cases = [
      ['versionなし(1として受理)', { app: 'narika', group_name: 'V1グループ', members: [{ name: 'まさと' }], expenses: [] }],
      ['version=1明示', { app: 'narika', version: 1, group_name: 'V1明示グループ', members: [{ name: 'まさと' }], expenses: [] }],
      ['version=2・base_currencyなし', { app: 'narika', version: 2, group_name: 'V2グループ', members: [{ name: 'まさと' }], expenses: [], rates: {} }],
    ];
    for (const [label, backup] of cases) {
      const { ctx, page, db } = await newCtx(browser);
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForSelector('#restore-file', { state: 'attached', timeout: 15000 });
      await doRestore(page, backup);
      await confirmRestoreOk(page, '復元しました');
      const groupPosts = db.rec.posts.filter(p => p.table === 'groups');
      ok(`[C] ${label}: groups INSERTが1回`, groupPosts.length === 1, JSON.stringify(groupPosts));
      const body = groupPosts[0] ? groupPosts[0].body : {};
      ok(`[C] ${label}: base_currency='JPY'で作成`, body.base_currency === 'JPY', JSON.stringify(body));
      const base = await page.evaluate(() => window.__getBaseCurrency());
      ok(`[C] ${label}: エンジン基準通貨がJPY`, base === 'JPY', base);
      const errs = await jsErrors(page);
      ok(`[C] ${label}: JSエラーなし`, errs.length === 0, errs.join('||'));
      await ctx.close();
    }
  }

  // ---------- D. version 3のJPY・USD復元 ----------
  {
    const cases = [
      ['JPY', { app: 'narika', version: 3, group_name: 'V3 JPYグループ', base_currency: 'JPY', members: [{ name: 'まさと' }], expenses: [], rates: {} }],
      ['USD', { app: 'narika', version: 3, group_name: 'V3 USDグループ', base_currency: 'USD', members: [{ name: 'まさと' }], expenses: [], rates: {} }],
    ];
    for (const [label, backup] of cases) {
      const { ctx, page, db } = await newCtx(browser);
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForSelector('#restore-file', { state: 'attached', timeout: 15000 });
      await doRestore(page, backup);
      await confirmRestoreOk(page, '復元しました');
      const groupPosts = db.rec.posts.filter(p => p.table === 'groups');
      const body = groupPosts[0] ? groupPosts[0].body : {};
      ok(`[D] version3 ${label}: base_currency='${backup.base_currency}'で作成`, body.base_currency === backup.base_currency, JSON.stringify(body));
      ok(`[D] version3 ${label}: nameとbase_currencyを同時保存`, body.name === backup.group_name && body.base_currency === backup.base_currency, JSON.stringify(body));
      const base = await page.evaluate(() => window.__getBaseCurrency());
      ok(`[D] version3 ${label}: エンジン基準通貨が'${backup.base_currency}'`, base === backup.base_currency, base);
      const errs = await jsErrors(page);
      ok(`[D] version3 ${label}: JSエラーなし`, errs.length === 0, errs.join('||'));
      await ctx.close();
    }
  }

  // ---------- E・F. 不正なbase_currencyは拒否・書込み0 ----------
  {
    const badCases = [
      ['欠落', undefined],
      ['null', null],
      ['空文字', ''],
      ['小文字', 'usd'],
      ['数値', 123],
      ['未知の3文字コード', 'ZZZ'],
    ];
    for (const [label, bad] of badCases) {
      const backup = { app: 'narika', version: 3, group_name: '不正' + label, members: [{ name: 'まさと' }], expenses: [] };
      if (bad !== undefined) backup.base_currency = bad;
      const { ctx, page, db } = await newCtx(browser);
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForSelector('#restore-file', { state: 'attached', timeout: 15000 });
      await doRestore(page, backup);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('modal-bg')).display !== 'none', { timeout: 15000 });
      const msg = await page.evaluate(() => document.getElementById('modal-msg').textContent);
      ok(`[E] base_currency${label}: 基準通貨を確認できない旨のダイアログ`, msg.includes('基準通貨'), msg);
      await page.click('#modal-ok');
      await page.waitForTimeout(300);
      ok(`[F] base_currency${label}: groups書込み0件`, db.rec.posts.filter(p => p.table === 'groups').length === 0, JSON.stringify(db.rec.posts));
      ok(`[F] base_currency${label}: 全テーブル書込み0件`, db.rec.posts.length === 0, JSON.stringify(db.rec.posts));
      const gids = await page.evaluate(() => localStorage.getItem('narika_gids'));
      ok(`[F] base_currency${label}: localStorage(narika_gids)に追加なし`, !gids || JSON.parse(gids).length === 0, String(gids));
      const mainShown = await page.evaluate(() => document.getElementById('p-main').classList.contains('show'));
      ok(`[F] base_currency${label}: グループ画面を開かない`, !mainShown, String(mainShown));
      const errs = await jsErrors(page);
      ok(`[F] base_currency${label}: JSエラーなし`, errs.length === 0, errs.join('||'));
      await ctx.close();
    }
  }

  // ---------- G. version 4以上・不正appは拒否 ----------
  {
    const rejectCases = [
      ['version=4', { app: 'narika', version: 4, group_name: '未来グループ', base_currency: 'USD', members: [], expenses: [] }],
      ['version=文字列"2"', { app: 'narika', version: '2', group_name: '文字列バージョン', members: [], expenses: [] }],
      ['app不正', { app: 'other-app', version: 2, group_name: '別アプリ', members: [], expenses: [] }],
    ];
    for (const [label, backup] of rejectCases) {
      const { ctx, page, db } = await newCtx(browser);
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForSelector('#restore-file', { state: 'attached', timeout: 15000 });
      await doRestore(page, backup);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('modal-bg')).display !== 'none', { timeout: 15000 });
      await page.click('#modal-ok');
      await page.waitForTimeout(300);
      ok(`[G] ${label}: 書込み0件`, db.rec.posts.length === 0, JSON.stringify(db.rec.posts));
      const mainShown = await page.evaluate(() => document.getElementById('p-main').classList.contains('show'));
      ok(`[G] ${label}: グループ画面を開かない`, !mainShown, String(mainShown));
      await ctx.close();
    }
  }

  // ---------- H. rates：復元でも基準通貨自身を除外する（逆数化・換算なし） ----------
  {
    const jpyBackup = { app: 'narika', version: 2, group_name: 'JPY復元rates', members: [{ name: 'まさと' }], expenses: [], rates: { JPY: 1, EUR: 0.006 } };
    {
      const { ctx, page, db } = await newCtx(browser);
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForSelector('#restore-file', { state: 'attached', timeout: 15000 });
      await doRestore(page, jpyBackup);
      await confirmRestoreOk(page, '復元しました');
      const rateRows = db.rec.posts.filter(p => p.table === 'rates').flatMap(p => Array.isArray(p.body) ? p.body : [p.body]);
      const codes = rateRows.map(r => r.currency).sort();
      deep('[H] JPY復元：ratesはEURのみ挿入（JPY自身は除外）', codes, ['EUR']);
      const eur = rateRows.find(r => r.currency === 'EUR');
      ok('[H] JPY復元：EURレートは0.006のまま（逆数化・換算なし）', eur && eur.rate === 0.006, JSON.stringify(eur));
      await ctx.close();
    }
    const usdBackup = { app: 'narika', version: 3, group_name: 'USD復元rates', base_currency: 'USD', members: [{ name: 'まさと' }], expenses: [], rates: { USD: 1, JPY: 150 } };
    {
      const { ctx, page, db } = await newCtx(browser);
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForSelector('#restore-file', { state: 'attached', timeout: 15000 });
      await doRestore(page, usdBackup);
      await confirmRestoreOk(page, '復元しました');
      const rateRows = db.rec.posts.filter(p => p.table === 'rates').flatMap(p => Array.isArray(p.body) ? p.body : [p.body]);
      const codes = rateRows.map(r => r.currency).sort();
      deep('[H] USD復元：ratesはJPYのみ挿入（USD自身は除外）', codes, ['JPY']);
      const jpy = rateRows.find(r => r.currency === 'JPY');
      ok('[H] USD復元：JPYレートは150のまま（逆数化・換算なし）', jpy && jpy.rate === 150, JSON.stringify(jpy));
      await ctx.close();
    }
  }

  // ---------- I. バックアップ→復元の往復で支払い・rates・精算結果が一致 ----------
  async function roundTripCase(label, baseCurrency, expenses, ratesRows) {
    const GID_SRC = `e2e-bk-rt-src-${baseCurrency}`;
    const { ctx: ctxSrc, page: pageSrc } = await newCtx(browser, {
      db: {
        groups: [{ id: GID_SRC, name: `${label}往復元`, base_currency: baseCurrency }],
        members: M3(GID_SRC),
        expenses: expenses.map((e, i) => Object.assign({ id: i + 1, group_id: GID_SRC, created_at: `2026-07-28T01:00:0${i}Z` }, e)),
        rates: ratesRows.map((r, i) => Object.assign({ id: i + 1, group_id: GID_SRC }, r)),
      },
      introSeen: [GID_SRC],
    });
    await pageSrc.goto(`${BASE}?g=${GID_SRC}`, { waitUntil: 'load' });
    await pageSrc.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await pageSrc.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const before = await engineState(pageSrc);
    const backup = await downloadBackup(pageSrc);
    await ctxSrc.close();

    const { ctx: ctxDst, page: pageDst, db: dbDst } = await newCtx(browser);
    await pageDst.goto(BASE, { waitUntil: 'load' });
    await pageDst.waitForSelector('#restore-file', { state: 'attached', timeout: 15000 });
    await doRestore(pageDst, backup);
    await confirmRestoreOk(pageDst, '復元しました');
    await pageDst.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const after = await engineState(pageDst);

    ok(`[I] ${label}: 往復後もエンジン基準通貨が一致`, after.base === before.base, `before=${before.base} after=${after.base}`);
    deep(`[I] ${label}: 往復後もpaid/owed/balが一致`, [after.paid, after.owed, after.bal], [before.paid, before.owed, before.bal]);
    ok(`[I] ${label}: 往復後も合計が一致`, after.total === before.total, `before=${before.total} after=${after.total}`);
    deep(`[I] ${label}: 往復後も送金一覧（settles）が一致`, after.settles, before.settles);
    const expPosts = dbDst.rec.posts.filter(p => p.table === 'expenses').flatMap(p => Array.isArray(p.body) ? p.body : [p.body]);
    const normExp = rows => rows.map(e => ({ name: e.name, currency: e.currency, amount: e.amount, split_mode: e.split_mode || 'equal' })).sort((a, b) => a.name.localeCompare(b.name));
    deep(`[I] ${label}: 復元された支払い内容が一致（名称・通貨・金額・分け方）`, normExp(expPosts), normExp(expenses));
    const ratePosts = dbDst.rec.posts.filter(p => p.table === 'rates').flatMap(p => Array.isArray(p.body) ? p.body : [p.body]);
    const expectedRates = ratesRows.filter(r => r.currency !== baseCurrency);
    deep(`[I] ${label}: 復元されたratesが一致（基準通貨自身を除く）`, ratePosts.map(r => ({ currency: r.currency, rate: r.rate })).sort((a, b) => a.currency.localeCompare(b.currency)), expectedRates.map(r => ({ currency: r.currency, rate: r.rate })).sort((a, b) => a.currency.localeCompare(b.currency)));
    const errs = await jsErrors(pageDst);
    ok(`[I] ${label}: 往復復元でJSエラーなし`, errs.length === 0, errs.join('||'));
    await ctxDst.close();
  }

  await roundTripCase('JPY', 'JPY', [
    { name: '旅館', date: '2026-07-28', amount: 9000, currency: 'JPY', payer: 'まさと', beneficiaries: 'まさと,たろう,はなこ', split_mode: 'equal', split_details: null },
    { name: 'ディナー', date: '2026-07-28', amount: 100, currency: 'EUR', payer: 'たろう', beneficiaries: 'まさと,たろう', split_mode: 'percentage', split_details: [{ member: 'まさと', share_permille: 500 }, { member: 'たろう', share_permille: 500 }] },
  ], [{ currency: 'EUR', rate: 160 }]);

  await roundTripCase('USD', 'USD', [
    { name: 'ホテル', date: '2026-07-28', amount: 30, currency: 'USD', payer: 'まさと', beneficiaries: 'まさと,たろう,はなこ', split_mode: 'equal', split_details: null },
    { name: 'タクシー', date: '2026-07-28', amount: 20, currency: 'USD', payer: 'たろう', beneficiaries: 'まさと,たろう', split_mode: 'percentage', split_details: [{ member: 'まさと', share_permille: 500 }, { member: 'たろう', share_permille: 500 }] },
    { name: 'お土産', date: '2026-07-28', amount: 1000, currency: 'JPY', payer: 'はなこ', beneficiaries: 'まさと,たろう,はなこ', split_mode: 'equal', split_details: null },
  ], [{ currency: 'JPY', rate: 0.0065 }]);

  // ---------- J. legacy:trueの既存通貨(HRK)をbase_currencyとする復元が成功する ----------
  {
    const backup = { app: 'narika', version: 3, group_name: 'legacy基準通貨グループ', base_currency: 'HRK', members: [{ name: 'まさと' }], expenses: [], rates: {} };
    const { ctx, page, db } = await newCtx(browser);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#restore-file', { state: 'attached', timeout: 15000 });
    await doRestore(page, backup);
    await confirmRestoreOk(page, '復元しました');
    const groupPosts = db.rec.posts.filter(p => p.table === 'groups');
    const body = groupPosts[0] ? groupPosts[0].body : {};
    ok('[J] legacy通貨(HRK)でもgroups INSERTが成功', groupPosts.length === 1 && body.base_currency === 'HRK', JSON.stringify(body));
    const base = await page.evaluate(() => window.__getBaseCurrency());
    ok('[J] legacy通貨(HRK)がエンジン基準通貨に反映される', base === 'HRK', base);
    const errs = await jsErrors(page);
    ok('[J] legacy基準通貨の復元でJSエラーなし', errs.length === 0, errs.join('||'));
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
  console.log(`\n==== 基準通貨バックアップ・復元E2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

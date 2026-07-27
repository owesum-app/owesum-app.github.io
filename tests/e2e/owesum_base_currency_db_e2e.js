// OweSum グループ基準通貨のDB連携（groups.base_currency）E2E（Playwright・本番DBアクセスなし）。
// 検証範囲：
//  A. /ja/ の新規グループ作成：groups INSERTに base_currency:'JPY' を明示し、既存項目（name）を欠落させない
//  B. グループ読込：DBのbase_currencyを正として内部エンジンへ設定する（JPY行→JPYエンジン）
//  C. USDモックグループ：/ja/ のURLで開いてもUSDがJPYへ上書きされず、エンジンはセント建てで計算する
//  D. 不正値・未知コード：黙ってJPYとして精算せず、読込を安全に中止する（グループを開かない）
//  E. base_currency欠落行：既存データ・既存E2Eモック互換としてJPYで開く（本番はNOT NULLのため通常発生しない）
//  F. 復元（バックアップ→新規グループ）でも base_currency:'JPY' を明示する
//  G. 通信安全：本番Supabase書込み0・全Supabase通信横取り・Google実通信0・group_created実送信0・想定外通信0
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

// ===== 外部通信ガード =====
// Google系は全横取り（gtag.jsは空スタブ・collectは204）。Supabaseはスイート固有モックが優先され、
// ここは取りこぼし用フォールバック。終了時に「観測件数＝横取り件数」を検査し、外部通過があればFAIL。
const NETG = { gaObserved: 0, gaCaptured: 0, supaObserved: 0, supaHandledTotal: 0, supaFallback: 0, otherExternal: [], gaEscaped: [], collectCaptured: [] };
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
  // route()はWebSocketを横取りできないため、realtime実接続はスタブで防ぐ
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
const GID_JPY = 'e2e-db-jpy-group';
const GID_USD = 'e2e-db-usd-group';
const GID_MISSING = 'e2e-db-missing-group';
const GID_BAD_LOWER = 'e2e-db-bad-lower';
const GID_BAD_UNKNOWN = 'e2e-db-bad-unknown';
const GID_BAD_TYPE = 'e2e-db-bad-type';
const mem = (id, gid, name, t) => ({ id, group_id: gid, name, created_at: `2026-07-28T00:00:0${t}Z` });
const M3 = gid => [mem(1, gid, 'まさと', 1), mem(2, gid, 'たろう', 2), mem(3, gid, 'はなこ', 3)];
// JPY：23,000円をまさとが立替・3人均等（負担7,667/7,667/7,666円）。USD：10.00ドル（1000セント）を同条件
const expRow = (id, gid, payer, amount, currency) => ({ id, group_id: gid, payer, amount, currency, beneficiaries: 'まさと,たろう,はなこ', split_mode: 'equal', split_details: null, date: '2026-07-28', created_at: '2026-07-28T01:00:00Z', name: 'テスト支払い' });

// ローカル完結の偽Supabase REST。GETはstateから返し、POSTは記録して成功応答（本番へは一切送らない）。
// それ以外のメソッドは遮断して記録する
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
  // netguardより後に登録するスイート固有ルートが優先され、Supabase通信はすべてここで横取りされる
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

// 精算エンジンの内部状態（基準通貨と計算結果）を取得する
async function engineState(page) {
  return page.evaluate(() => {
    const s = window.computeSettlements();
    const names = ['まさと', 'たろう', 'はなこ'];
    const round = o => names.map(n => Math.round(o[n] || 0));
    return {
      base: window.__getBaseCurrency(),
      paid: round(s.paid), owed: round(s.owed), bal: round(s.bal),
      total: Math.round(s.total), missing: s.missing, ready: s.ready,
      settles: s.settles,
    };
  });
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const BASE = `http://localhost:${PORT}/ja/`;
  const browser = await chromium.launch();

  // ---------- A. /ja/ の新規グループ作成：INSERTに base_currency:'JPY' を明示 ----------
  {
    const { ctx, page, db } = await newCtx(browser);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#btn-hero-create', { timeout: 15000 });
    await page.click('#btn-hero-create');
    await page.waitForSelector('#gname-modal', { timeout: 15000 });
    await page.fill('#gname-modal', '基準通貨テスト');
    await page.click('#create-ok');
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    const groupPosts = db.rec.posts.filter(p => p.table === 'groups');
    ok('[A] groups INSERTが1回だけ発行される', groupPosts.length === 1, JSON.stringify(groupPosts));
    const body = groupPosts.length ? groupPosts[0].body : {};
    ok('[A] INSERTに base_currency:\'JPY\' が明示されている', body && body.base_currency === 'JPY', JSON.stringify(body));
    ok('[A] 既存項目nameが欠落・変更していない', body && body.name === '基準通貨テスト', JSON.stringify(body));
    deep('[A] INSERT項目はname＋base_currencyのみ（余計な項目を送らない）', Object.keys(body || {}).sort(), ['base_currency', 'name']);
    const st = await page.evaluate(() => ({ base: window.__getBaseCurrency(), title: document.getElementById('g-title').textContent }));
    ok('[A] 作成直後のエンジン基準通貨がJPY', st.base === 'JPY', st.base);
    ok('[A] 作成したグループが開いている', st.title === '基準通貨テスト', st.title);
    const errs = await jsErrors(page);
    ok('[A] 作成フローでJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- B. JPYグループ読込：DB行のbase_currency='JPY'でJPYエンジンになる ----------
  {
    const { ctx, page } = await newCtx(browser, {
      db: { groups: [{ id: GID_JPY, name: 'JPY旅行', base_currency: 'JPY' }], members: M3(GID_JPY), expenses: [expRow(10, GID_JPY, 'まさと', 23000, 'JPY')] },
      introSeen: [GID_JPY],
    });
    await page.goto(`${BASE}?g=${GID_JPY}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('#member-list .m-item, #member-list [data-i]').length >= 0 && window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const r = await engineState(page);
    ok('[B] エンジン基準通貨がJPY', r.base === 'JPY', r.base);
    ok('[B] 合計23,000円（円建て計算）', r.total === 23000, String(r.total));
    deep('[B] 負担が7,667/7,667/7,666円（既存JPY仕様どおり）', r.owed, [7667, 7667, 7666]);
    ok('[B] レート不足なし・精算可能', r.missing.length === 0 && r.ready === true, JSON.stringify(r.missing));
    const errs = await jsErrors(page);
    ok('[B] JPYグループ読込でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- C. USDモックグループ：/ja/ で開いてもUSDエンジンになる（URLで上書きしない） ----------
  {
    const { ctx, page } = await newCtx(browser, {
      db: { groups: [{ id: GID_USD, name: 'USD旅行', base_currency: 'USD' }], members: M3(GID_USD), expenses: [expRow(20, GID_USD, 'まさと', 10, 'USD')] },
      introSeen: [GID_USD],
    });
    await page.goto(`${BASE}?g=${GID_USD}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const urlPath = await page.evaluate(() => location.pathname);
    ok('[C] URLは /ja/ のまま', urlPath.includes('/ja/'), urlPath);
    const r = await engineState(page);
    ok('[C] /ja/ のURLでもエンジン基準通貨はDBどおりUSD（JPYへ上書きされない）', r.base === 'USD', r.base);
    // エンジンがUSD基準である決定的証拠：USD支払いにレート入力が要求されず（missing空）、
    // 金額はセント建て整数（10.00ドル=1000セント）で計算される。JPY基準ならUSDレート不足でready=falseになる
    ok('[C] USD支払いにレート入力が要求されない（USDが基準通貨自身）', r.missing.length === 0 && r.ready === true, JSON.stringify(r.missing));
    ok('[C] 合計1000セント（セント建て・整数）', r.total === 1000, String(r.total));
    deep('[C] 負担334/333/333セント', r.owed, [334, 333, 333]);
    deep('[C] 送金333セント×2本', r.settles.map(s => s.amt), [333, 333]);
    const errs = await jsErrors(page);
    ok('[C] USDグループ読込でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- C-2. USDグループ→一覧→JPYグループでエンジンがJPYへ戻る（汚染なし） ----------
  {
    const { ctx, page } = await newCtx(browser, {
      db: {
        groups: [
          { id: GID_USD, name: 'USD旅行', base_currency: 'USD' },
          { id: GID_JPY, name: 'JPY旅行', base_currency: 'JPY' },
        ],
        members: M3(GID_USD).concat(M3(GID_JPY).map(m => Object.assign({}, m, { id: m.id + 100 }))),
        expenses: [expRow(20, GID_USD, 'まさと', 10, 'USD'), expRow(30, GID_JPY, 'まさと', 23000, 'JPY')],
      },
      introSeen: [GID_USD, GID_JPY],
      gids: [GID_USD, GID_JPY],
    });
    await page.goto(`${BASE}?g=${GID_USD}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => window.__getBaseCurrency() === 'USD', { timeout: 15000 });
    await page.click('#btn-back');
    await page.waitForSelector(`.g-item[data-id="${GID_JPY}"]`, { timeout: 15000 });
    await page.click(`.g-item[data-id="${GID_JPY}"]`);
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => window.computeSettlements && window.computeSettlements().total === 23000, { timeout: 15000 });
    const r = await engineState(page);
    ok('[C2] 一覧経由でJPYグループを開くとエンジンがJPYへ戻る', r.base === 'JPY', r.base);
    ok('[C2] JPYグループの計算が円建て（合計23,000円）', r.total === 23000, String(r.total));
    const errs = await jsErrors(page);
    ok('[C2] グループ切替でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- D. 不正値・未知コード：黙ってJPY扱いせず読込を安全に中止する ----------
  const badCases = [
    ['小文字3文字', GID_BAD_LOWER, 'usd'],
    ['未知の3文字コード', GID_BAD_UNKNOWN, 'ZZZ'],
    ['文字列以外', GID_BAD_TYPE, 123],
  ];
  for (const [label, gid, bad] of badCases) {
    const { ctx, page } = await newCtx(browser, {
      db: { groups: [{ id: gid, name: '不正' + label, base_currency: bad }], members: M3(gid), expenses: [expRow(40, gid, 'まさと', 23000, 'JPY')] },
      introSeen: [gid],
    });
    await page.goto(`${BASE}?g=${gid}`, { waitUntil: 'load' });
    await page.waitForFunction(() => getComputedStyle(document.getElementById('modal-bg')).display !== 'none', { timeout: 15000 });
    const st1 = await page.evaluate(() => ({
      msg: document.getElementById('modal-msg').textContent,
      mainShown: document.getElementById('p-main').classList.contains('show'),
    }));
    ok(`[D] ${label}: 基準通貨を確認できない旨のダイアログが出る`, st1.msg.includes('基準通貨'), st1.msg);
    ok(`[D] ${label}: グループ画面を開かない（黙ってJPYで精算しない）`, !st1.mainShown, JSON.stringify(st1));
    await page.click('#modal-ok');
    await page.waitForFunction(() => document.getElementById('p-group').classList.contains('show'), { timeout: 15000 });
    const st2 = await page.evaluate(() => ({
      mainShown: document.getElementById('p-main').classList.contains('show'),
      settleText: document.getElementById('s-result') ? document.getElementById('s-result').textContent : '',
    }));
    ok(`[D] ${label}: OK後はグループ一覧へ安全に戻る`, !st2.mainShown, JSON.stringify(st2));
    ok(`[D] ${label}: 精算結果（誤ったJPY金額）を表示していない`, !/円/.test(st2.settleText), st2.settleText.slice(0, 60));
    const errs = await jsErrors(page);
    ok(`[D] ${label}: JSエラーなし`, errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- E. base_currency欠落行：既存モック互換としてJPYで開く ----------
  {
    const { ctx, page } = await newCtx(browser, {
      db: { groups: [{ id: GID_MISSING, name: '欠落互換' }], members: M3(GID_MISSING), expenses: [expRow(50, GID_MISSING, 'まさと', 23000, 'JPY')] },
      introSeen: [GID_MISSING],
    });
    await page.goto(`${BASE}?g=${GID_MISSING}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    const r = await engineState(page);
    ok('[E] base_currency欠落行は後方互換でJPYとして開く', r.base === 'JPY', r.base);
    ok('[E] 円建て計算（合計23,000円）', r.total === 23000, String(r.total));
    const errs = await jsErrors(page);
    ok('[E] 欠落互換読込でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- F. 復元（バックアップ→新規グループ）でも base_currency:'JPY' を明示 ----------
  {
    const { ctx, page, db } = await newCtx(browser);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#restore-file', { state: 'attached', timeout: 15000 });
    const backup = { app: 'narika', version: 2, group_name: '復元グループ', members: [{ name: 'まさと' }], expenses: [], rates: {} };
    await page.setInputFiles('#restore-file', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup), 'utf8') });
    // 確認ダイアログ「復元します…よろしいですか？」→OK
    await page.waitForFunction(() => getComputedStyle(document.getElementById('modal-bg')).display !== 'none', { timeout: 15000 });
    await page.click('#modal-ok');
    // 完了ダイアログ「復元しました！」→OK
    await page.waitForFunction(() => document.getElementById('modal-msg').textContent.includes('復元しました'), { timeout: 15000 });
    await page.click('#modal-ok');
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    const groupPosts = db.rec.posts.filter(p => p.table === 'groups');
    ok('[F] 復元でのgroups INSERTが1回', groupPosts.length === 1, JSON.stringify(groupPosts));
    const body = groupPosts.length ? groupPosts[0].body : {};
    ok('[F] 復元INSERTにも base_currency:\'JPY\' を明示', body && body.base_currency === 'JPY', JSON.stringify(body));
    ok('[F] 復元INSERTのnameが維持されている', body && body.name === '復元グループ', JSON.stringify(body));
    const base = await page.evaluate(() => window.__getBaseCurrency());
    ok('[F] 復元グループのエンジン基準通貨がJPY', base === 'JPY', base);
    const errs = await jsErrors(page);
    ok('[F] 復元フローでJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- G. 通信安全 ----------
  ok('[G] Supabase宛の発行数＝横取り数（本番到達0件）', NETG.supaObserved === NETG.supaHandledTotal, `observed=${NETG.supaObserved} handled=${NETG.supaHandledTotal}`);
  ok('[G] スイート固有モックの取りこぼし0件（フォールバック横取り0）', NETG.supaFallback === 0, String(NETG.supaFallback));
  ok('[G] Google向け通信が外部へ通過していない（実通信0）', NETG.gaObserved === NETG.gaCaptured, `observed=${NETG.gaObserved} captured=${NETG.gaCaptured}`);
  ok('[G] Google向け通信を観測できている（ガードの実効性確認）', NETG.gaObserved > 0, String(NETG.gaObserved));
  ok('[G] group_createdの実送信0（収集リクエストは全横取り・外部通過0）', NETG.gaObserved === NETG.gaCaptured && NETG.otherExternal.every(u => !u.includes('group_created')), NETG.collectCaptured.filter(c => c.includes('group_created')).join('||'));
  ok('[G] 想定外の外部通信0件', NETG.otherExternal.length === 0, NETG.otherExternal.slice(0, 5).join(' || '));

  await browser.close();
  server.close();
  console.log(`[netguard] Google捕捉=${NETG.gaCaptured} Google外部通過=${NETG.gaObserved - NETG.gaCaptured} Supabase観測=${NETG.supaObserved}（うちフォールバック横取り=${NETG.supaFallback}） 想定外外部通信=${NETG.otherExternal.length}`);
  console.log(`\n==== 基準通貨DB連携E2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

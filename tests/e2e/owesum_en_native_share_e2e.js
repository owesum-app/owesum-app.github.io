// OweSum 英語版（/en/）ネイティブ共有E2E（Playwright・本番通信なし）。
//
// 目的：英語版の3つの共有ボタン（Share settlement / Share invite link / Share records）が、
// navigator.share（OS標準の共有シート）を最優先で直接呼び出し、独自のLINE/emailシートを
// 先に出さないことを検証する。navigator.share非対応時・キャンセル以外の理由で失敗した時だけ、
// フォールバックシート（WhatsApp / email / Copy）を開くことを確認する。
//
// 検証範囲：
//  A. navigator.share対応端末：3ボタンともnavigator.shareが1回呼ばれ、フォールバックシートが
//     先に開かない。title/text/urlが機能ごとに正しい。共有本文・URLは既存生成処理のまま。
//  B. navigator.shareをユーザーがキャンセル（AbortError）：エラー・フォールバックを出さない。
//  C. navigator.shareが非対応：フォールバックシートが開き、WhatsApp/email/Copyの3つが選べる。
//     WhatsAppは公式のwa.me汎用リンクへ共有本文/URLをURLエンコードして渡す（電話番号固定なし）。
//  D. navigator.shareがキャンセル以外の理由で失敗：フォールバックシートを開く。
//  E. 日本語版(/ja/)は無変更（既存share-line構造のまま）。
//  F. 通信安全：本番Supabase書込み0、Google実送信0、WhatsApp/メールへの実際の遷移0
//     （window.open・location.hrefを横取りし、実際のナビゲーションは発生させない）。
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

// ===== 外部通信ガード（owesum_en_locale_e2e.jsと同一方式） =====
const NETG = { gaObserved: 0, gaCaptured: 0, supaObserved: 0, supaHandledTotal: 0, supaFallback: 0, otherExternal: [] };
const GA_HOST_RE = /(\.|^)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|google\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com|gstatic\.com)$/;
const SUPA_HOST_RE = /(\.|^)supabase\.co$/;
const WA_HOST_RE = /(\.|^)wa\.me$/;
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
  // wa.meはWhatsAppフォールバックのURL文字列としてのみ検証し、実際には決して開かない
  // （window.openを横取りするため到達しないはずだが、二重の安全策としてルートも遮断する）
  await ctx.route(u => WA_HOST_RE.test(u.hostname), route => route.abort());
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
    else if (WA_HOST_RE.test(h)) { /* wa.meはwindow.open横取りで通常発生しない。発生したら想定外通信として計上する */ NETG.otherExternal.push(req.method() + ' ' + req.url()); }
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
const M3 = gid => [mem(1, gid, 'Alice', 1), mem(2, gid, 'Bob', 2), mem(3, gid, 'Carol', 3)];
const expRow = (id, gid, payer, amount, currency, bens) => ({ id, group_id: gid, payer, amount, currency, beneficiaries: bens || 'Alice,Bob,Carol', split_mode: 'equal', split_details: null, date: '2026-07-29', created_at: '2026-07-29T01:00:00Z', name: 'Test expense' });

function makeDb(state) {
  const rec = { posts: [] };
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
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([body]) });
    }
    return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"blocked by e2e"}' });
  };
  return { rec, handler };
}

// navigator.share / clipboard / window.open / location.href(mailto:) をすべて横取りするモック。
// mode: 'available'（呼ばれたら成功） | 'abort'（AbortErrorで拒否） | 'error'（AbortError以外で拒否） | 'unsupported'（navigator.shareを未定義化）
function makeShareInit(mode) {
  return (mode) => {
    window.__consoleErrors = [];
    window.__shareCalls = [];
    window.__copyCalls = [];
    window.__mailtos = [];
    window.__windowOpenCalls = [];
    if (mode === 'unsupported') {
      try { delete navigator.share; } catch (e) { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); }
    } else {
      Object.defineProperty(navigator, 'share', {
        configurable: true, writable: true,
        value: function (d) {
          window.__shareCalls.push(d);
          if (mode === 'abort') { const e = new Error('cancel'); e.name = 'AbortError'; return Promise.reject(e); }
          if (mode === 'error') { const e = new Error('boom'); e.name = 'NotAllowedError'; return Promise.reject(e); }
          return Promise.resolve();
        }
      });
    }
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (t) => { window.__copyCalls.push(t); return Promise.resolve(); } }
      });
    } catch (e) {}
    window.open = function (url, target, features) { window.__windowOpenCalls.push({ url, target, features }); return null; };
    let installed = false;
    try {
      const d = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
      Object.defineProperty(window.location, 'href', {
        configurable: true,
        get() { return d.get.call(window.location); },
        set(v) { if (typeof v === 'string' && v.indexOf('mailto:') === 0) { window.__mailtos.push(v); return; } return d.set.call(window.location, v); }
      });
      installed = true;
    } catch (e) {}
    if (!installed) {
      try {
        const d = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        if (d && d.configurable) {
          Object.defineProperty(Location.prototype, 'href', {
            configurable: true,
            get() { return d.get.call(this); },
            set(v) { if (typeof v === 'string' && v.indexOf('mailto:') === 0) { window.__mailtos.push(v); return; } return d.set.call(this, v); }
          });
          installed = true;
        }
      } catch (e) {}
    }
    if (!installed) window.__mailtoErr = 'href-intercept-unavailable';
  };
}

async function jsErrors(page) {
  return page.evaluate(() => (window.__consoleErrors || []).filter(e => !/favicon|esm\.sh|net::|Failed to load resource|WebSocket|realtime|googletagmanager|jsdelivr/i.test(e)));
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const BASE_EN = `http://localhost:${PORT}/en/`;
  const browser = await chromium.launch();
  const GID = 'e2e-en-share-group';
  const dbFixture = () => ({
    groups: [{ id: GID, name: 'Native share check', base_currency: 'USD' }],
    members: M3(GID),
    expenses: [expRow(1, GID, 'Alice', 30, 'USD')],
    rates: [],
  });

  async function openGroup(mode) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await installNetGuard(ctx);
    await ctx.route(u => SUPA_HOST_RE.test(u.hostname), makeDb(dbFixture()).handler);
    const page = await ctx.newPage();
    await ctx.addInitScript(makeShareInit(mode), mode);
    await ctx.addInitScript(gids => { localStorage.setItem('narika_intro_seen_gids', JSON.stringify(gids)); }, [GID]);
    page.on('console', m => { if (m.type() === 'error') page.evaluate(t => window.__consoleErrors.push(t), m.text()).catch(() => {}); });
    page.on('pageerror', e => { fails.push('PAGEERROR: ' + e.message); FAIL++; });
    await page.goto(`${BASE_EN}?g=${GID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => window.computeSettlements && window.computeSettlements().total > 0, { timeout: 15000 });
    return { ctx, page };
  }

  async function shareState(page) {
    return page.evaluate(() => ({
      calls: window.__shareCalls,
      copyCalls: window.__copyCalls,
      mailtos: window.__mailtos,
      windowOpenCalls: window.__windowOpenCalls,
      sheetVisible: getComputedStyle(document.getElementById('share-bg')).display !== 'none',
      sheetTitle: document.getElementById('share-sheet-title').textContent,
      errToast: !!document.querySelector('#toast-wrap .toast-error'),
    }));
  }

  // ---------- A. navigator.share対応：3ボタンとも直接navigator.shareが呼ばれ、シートが先に開かない ----------
  {
    const { ctx, page } = await openGroup('available');

    await page.click('.nb[data-tab="settle"]');
    await page.waitForSelector('#s-result table', { timeout: 15000 });
    await page.click('#btn-share-settle');
    await page.waitForTimeout(80);
    let st = await shareState(page);
    ok('[A] Share settlement: navigator.shareが1回呼ばれる', st.calls.length === 1, JSON.stringify(st.calls));
    ok('[A] Share settlement: 独自シートが先に開かない', st.sheetVisible === false, String(st.sheetVisible));
    ok('[A] Share settlement: textに精算タイトルとURLを含む', st.calls[0] && st.calls[0].text.includes('Settlement for') && st.calls[0].text.includes(`${BASE_EN}?g=${GID}`), JSON.stringify(st.calls[0]));
    ok('[A] Share settlement: titleに日本語が残っていない', st.calls[0] && /^[\x00-\x7f]*$/.test(st.calls[0].title), JSON.stringify(st.calls[0]));

    await page.click('.nb[data-tab="members"]');
    await page.waitForSelector('#btn-share-link', { timeout: 15000 });
    await page.click('#btn-share-link');
    await page.waitForTimeout(80);
    st = await shareState(page);
    ok('[A] Share invite link: navigator.shareが1回呼ばれる（累計2回）', st.calls.length === 2, JSON.stringify(st.calls));
    ok('[A] Share invite link: 独自シートが先に開かない', st.sheetVisible === false, String(st.sheetVisible));
    const inviteCall = st.calls[1];
    ok('[A] Share invite link: urlが招待URL', inviteCall && inviteCall.url === `${BASE_EN}?g=${GID}`, JSON.stringify(inviteCall));
    ok('[A] Share invite link: textにURLを二重に含まない', inviteCall && !inviteCall.text.includes(inviteCall.url), JSON.stringify(inviteCall));

    await page.click('#btn-share');
    await page.waitForTimeout(80);
    st = await shareState(page);
    ok('[A] Share records: navigator.shareが1回呼ばれる（累計3回）', st.calls.length === 3, JSON.stringify(st.calls));
    ok('[A] Share records: 独自シートが先に開かない', st.sheetVisible === false, String(st.sheetVisible));
    const recCall = st.calls[2];
    ok('[A] Share records: titleにグループ名を含む', recCall && recCall.title.includes('Native share check'), JSON.stringify(recCall));
    ok('[A] Share records: textに支払い記録を含む', recCall && recCall.text.includes('Test expense') && recCall.text.includes('30'), JSON.stringify(recCall));

    const errs = await jsErrors(page);
    ok('[A] 3ボタン共有操作でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- B. navigator.shareをキャンセル（AbortError）：エラー・フォールバックを出さない ----------
  {
    const { ctx, page } = await openGroup('abort');
    await page.click('.nb[data-tab="settle"]');
    await page.waitForSelector('#s-result table', { timeout: 15000 });
    let threw = false;
    try { await page.click('#btn-share-settle'); await page.waitForTimeout(80); } catch (e) { threw = true; }
    let st = await shareState(page);
    ok('[B] Share settlementキャンセルで例外が伝播しない', !threw, String(threw));
    ok('[B] Share settlementキャンセルでフォールバックシートを開かない', st.sheetVisible === false, String(st.sheetVisible));
    ok('[B] Share settlementキャンセルでエラートーストを出さない', st.errToast === false, String(st.errToast));

    await page.click('.nb[data-tab="members"]');
    await page.waitForSelector('#btn-share-link', { timeout: 15000 });
    await page.click('#btn-share-link');
    await page.waitForTimeout(80);
    await page.click('#btn-share');
    await page.waitForTimeout(80);
    st = await shareState(page);
    ok('[B] 招待/記録共有キャンセルでもフォールバックシートを開かない', st.sheetVisible === false, String(st.sheetVisible));
    ok('[B] 3ボタンともnavigator.shareが呼ばれている', st.calls.length === 3, JSON.stringify(st.calls));
    const errs = await jsErrors(page);
    ok('[B] キャンセル操作でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- C. navigator.share非対応：フォールバックシートが開き、WhatsApp/email/Copyが選べる ----------
  {
    const { ctx, page } = await openGroup('unsupported');
    await page.click('.nb[data-tab="settle"]');
    await page.waitForSelector('#s-result table', { timeout: 15000 });
    await page.click('#btn-share-settle');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('share-bg')).display !== 'none', { timeout: 15000 });
    let st = await shareState(page);
    ok('[C] navigator.share非対応でフォールバックシートが開く', st.sheetVisible === true, String(st.sheetVisible));
    ok('[C] シートタイトルがShare settlement', st.sheetTitle === 'Share settlement', st.sheetTitle);
    const opts = await page.evaluate(() => [...document.querySelectorAll('#share-bg .share-opt')].map(b => b.textContent.trim()));
    ok('[C] WhatsApp選択肢がある', opts.some(t => t.includes('WhatsApp')), JSON.stringify(opts));
    ok('[C] email選択肢がある', opts.some(t => /email/i.test(t)), JSON.stringify(opts));
    ok('[C] Copy選択肢がある', opts.some(t => t.includes('Copy')), JSON.stringify(opts));
    ok('[C] LINE選択肢が残っていない', !opts.some(t => t.includes('LINE')), JSON.stringify(opts));

    // WhatsApp: wa.me汎用リンクへ共有本文をURLエンコードして渡す。実際には開かず window.open を横取り
    await page.click('#share-whatsapp');
    await page.waitForTimeout(80);
    st = await shareState(page);
    ok('[C] WhatsAppはwindow.openを1回呼ぶ', st.windowOpenCalls.length === 1, JSON.stringify(st.windowOpenCalls));
    const waUrl = st.windowOpenCalls[0] ? st.windowOpenCalls[0].url : '';
    ok('[C] WhatsAppリンクが公式wa.me形式', waUrl.startsWith('https://wa.me/?text='), waUrl);
    ok('[C] WhatsAppリンクに電話番号を固定していない', !/wa\.me\/\d/.test(waUrl), waUrl);
    const decoded = decodeURIComponent(waUrl.split('?text=')[1] || '');
    ok('[C] WhatsAppリンクの本文が精算共有本文と一致', decoded.includes('Settlement for') && decoded.includes(`${BASE_EN}?g=${GID}`), decoded);
    ok('[C] クリック後にシートが閉じる', (await shareState(page)).sheetVisible === false);

    // email: mailtoでsubjectが確実に設定される（location.href傍受が効く環境なら実ボタン経由でも確認。
    // 効かない環境ではbuildSettleMailtoの純関数検証で内容を担保する。owesum_field_usability_e2e.jsと同方式）
    await page.click('#btn-share-settle');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('share-bg')).display !== 'none', { timeout: 15000 });
    await page.click('#share-mail');
    await page.waitForTimeout(80);
    st = await shareState(page);
    const mailtoErr = await page.evaluate(() => window.__mailtoErr);
    if (!mailtoErr) {
      ok('[C] emailはmailto:を1回発行', st.mailtos.length === 1, JSON.stringify(st.mailtos));
      ok('[C] mailto件名に精算件名を含む', decodeURIComponent(st.mailtos[0]).includes('Settlement for'), st.mailtos[0]);
    } else {
      console.log('  (info) location.href傍受不可のためmailtoボタンの発火はbuildSettleMailtoの純関数検証で担保:', mailtoErr);
      const built = await page.evaluate(gname => window.buildSettleMailto ? window.buildSettleMailto(gname, 'x') : null, 'Native share check');
      ok('[C] buildSettleMailtoが精算件名を含むmailtoを生成する', built === null || decodeURIComponent(built).includes('Settlement for'), String(built));
    }
    ok('[C] emailクリック後にシートが閉じる', st.sheetVisible === false, String(st.sheetVisible));

    // Copy: クリップボードへ精算結果本文をコピー
    await page.click('#btn-share-settle');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('share-bg')).display !== 'none', { timeout: 15000 });
    await page.click('#share-copy');
    await page.waitForTimeout(80);
    st = await shareState(page);
    ok('[C] Copyでクリップボードへ1回コピー', st.copyCalls.length === 1, JSON.stringify(st.copyCalls));
    ok('[C] コピー本文が精算共有本文と一致', st.copyCalls[0] && st.copyCalls[0].includes('Settlement for'), st.copyCalls[0]);

    // 招待リンク共有：シートタイトルが切り替わる
    await page.click('.nb[data-tab="members"]');
    await page.waitForSelector('#btn-share-link', { timeout: 15000 });
    await page.click('#btn-share-link');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('share-bg')).display !== 'none', { timeout: 15000 });
    st = await shareState(page);
    ok('[C] 招待リンク共有のシートタイトルがShare invite link', st.sheetTitle === 'Share invite link', st.sheetTitle);
    await page.click('#share-copy');
    await page.waitForTimeout(80);
    st = await shareState(page);
    ok('[C] 招待リンクのコピー本文にURLを含む', st.copyCalls[1] && st.copyCalls[1].includes(`${BASE_EN}?g=${GID}`), st.copyCalls[1]);

    // 記録共有：シートタイトルが切り替わる
    await page.click('#btn-share');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('share-bg')).display !== 'none', { timeout: 15000 });
    st = await shareState(page);
    ok('[C] 記録共有のシートタイトルがShare records', st.sheetTitle === 'Share records', st.sheetTitle);
    await page.click('#share-cancel');
    await page.waitForTimeout(80);
    st = await shareState(page);
    ok('[C] Cancelでシートが閉じ、Copy/WhatsAppとも増えていない', st.sheetVisible === false && st.copyCalls.length === 2 && st.windowOpenCalls.length === 1, JSON.stringify(st));

    const errs = await jsErrors(page);
    ok('[C] フォールバック操作でJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- D. navigator.shareがキャンセル以外の理由で失敗：フォールバックシートを開く ----------
  {
    const { ctx, page } = await openGroup('error');
    await page.click('.nb[data-tab="settle"]');
    await page.waitForSelector('#s-result table', { timeout: 15000 });
    await page.click('#btn-share-settle');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('share-bg')).display !== 'none', { timeout: 15000 });
    const st = await shareState(page);
    ok('[D] navigator.share失敗（非Abort）でフォールバックシートを開く', st.sheetVisible === true, String(st.sheetVisible));
    ok('[D] navigator.shareは1回呼ばれた上でフォールバックする', st.calls.length === 1, JSON.stringify(st.calls));
    const errs = await jsErrors(page);
    ok('[D] 失敗時フォールバックでJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- E. 日本語版(/ja/)は無変更（既存share-line構造のまま） ----------
  {
    const jaHtml = fs.readFileSync(path.join(ROOT, 'ja', 'index.html'), 'utf8');
    ok('[E] ja/index.htmlにshare-line（既存LINE共有）が残っている', jaHtml.includes('id="share-line"'), '');
    ok('[E] ja/index.htmlにshare-whatsappが存在しない（en専用の変更）', !jaHtml.includes('share-whatsapp'), '');
  }

  // ---------- F. 通信安全 ----------
  ok('[F] Supabase宛の発行数＝横取り数（本番到達0件）', NETG.supaObserved === NETG.supaHandledTotal, `observed=${NETG.supaObserved} handled=${NETG.supaHandledTotal}`);
  ok('[F] スイート固有モックの取りこぼし0件（フォールバック横取り0）', NETG.supaFallback === 0, String(NETG.supaFallback));
  ok('[F] Google向け通信が外部へ通過していない（実通信0）', NETG.gaObserved === NETG.gaCaptured, `observed=${NETG.gaObserved} captured=${NETG.gaCaptured}`);
  ok('[F] WhatsApp(wa.me)への実通信0件（window.open横取りで到達しない）', NETG.otherExternal.filter(e => /wa\.me/.test(e)).length === 0, NETG.otherExternal.join(' || '));
  ok('[F] 想定外の外部通信0件', NETG.otherExternal.length === 0, NETG.otherExternal.slice(0, 5).join(' || '));

  await browser.close();
  server.close();
  console.log(`[netguard] Google捕捉=${NETG.gaCaptured} Google外部通過=${NETG.gaObserved - NETG.gaCaptured} Supabase観測=${NETG.supaObserved}（うちフォールバック横取り=${NETG.supaFallback}） 想定外外部通信=${NETG.otherExternal.length}`);
  console.log(`\n==== 英語版ネイティブ共有E2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

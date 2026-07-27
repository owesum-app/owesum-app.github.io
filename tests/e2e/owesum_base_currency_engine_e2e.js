// OweSum 基準通貨エンジン（USD・セント単位）E2E（Playwright・本番通信なし）。
//
// 目的：精算エンジン内部を「基準通貨の最小単位」建て（JPY=円、USD=セント）へ一般化した後、
// USD基準でも1セント単位で正しく精算できることを、テスト専用の基準通貨切替
// （__setSettleStateの第6引数。省略時は必ずJPY）経由で検証する。
// 通常の日本語版は引き続きJPY固定で、利用者向けのUSD表示・切替UIは存在しない。
//
// 期待値の出所（スナップショット自動生成ではない）：
//  1. 手計算（配分・換算・貪欲法マッチング・丸めを仕様どおり筆算）
//  2. アプリのコードを共有しない独立実装（scratchpadのusd_verify.js）で照合
//  3. 両者一致を確認した整数minor unit（セント）だけを本ファイルへ明示的にハードコード
// 期待値をテスト実行で自動更新する仕組みは意図的に持たない。期待値の変更は仕様変更そのものなので、
// 変更する場合は必ず理由をレビューすること。
//
// ケース構成：
//  U1 USDのみ・均等割り（10.00 USD/3人 → 334/333/333セント、送金333セント×2本、レート入力不要）
//  U2 割り切れないセント（10.01 USD・34%/33%/33% → 最大剰余法で341/330/330、合計1001セント保存）
//  U3 複数支払い・相互立替（4人・3人が立替、＋/−/0残高、循環なし、債権総額=送金総額）
//  U4 JPY混在（1 JPY=0.0068 USD固定レート。JPY→セント換算、レート欠損時missing=['JPY']）
//  U5 EUR混在（1 EUR=1.08 USD固定レート。EUR+USD支払いのセント精算）
//  U6 丸め単位（同一データでroundUnit=1/10/100 → 1セント/10セント/1ドル単位）
//  U7 欠損レート（EUR・KRWレートなし → ready=false・missing出現順・送金なし・共有不可）
//  U8 JPY後方互換（第6引数'JPY'明示・5引数省略の両方でゴールデン同値。既存ゴールデン92件は別ファイルのまま）
//  G  ガード（BASE_CURRENCYをwindowへ公開しない・不正な基準通貨指定はJPYへ戻る）
//  N  通信検証（Supabase/Google発行数＝横取り数、書込み0件、想定外外部通信0）
//
// 本番為替レートは使用しない（テスト内固定レートのみ）。本番Supabaseへは接続しない。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = 'C:\\Users\\narim\\OweSum';
const MIME = { '.html': 'text/html;charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

let PASS = 0, FAIL = 0; const fails = [];
function ok(name, cond, extra) { if (cond) { PASS++; } else { FAIL++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); } }
function deep(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, `actual=${a} expected=${e}`);
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

const GID = 'e2e-base-currency-group';
const M3 = [{ name: 'まさと' }, { name: 'たろう' }, { name: 'はなこ' }];
const M4 = [{ name: 'まさと' }, { name: 'たろう' }, { name: 'はなこ' }, { name: 'よしお' }];
const B3 = 'まさと,たろう,はなこ';
const B4 = 'まさと,たろう,はなこ,よしお';
const exp = (id, payer, amount, currency, beneficiaries, extra) => Object.assign(
  { id, group_id: GID, payer, amount, currency, beneficiaries, split_mode: 'equal', split_details: null, date: '2026-07-01', name: '支払い' + id, created_at: '2026-07-01T00:00:00Z' }, extra || {});

// ===== 通信の記録（ゴールデンE2Eと同方式） =====
let allRequests = [];
let supabaseSeen = [], supabaseHandled = [], supabaseWrites = [];
let gaSeen = [], gaHandled = [], collectHits = [];
const GA_HOST_RE = /(\.|^)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|google\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com|gstatic\.com)$/;
const SUPA_HOST_RE = /(\.|^)supabase\.co$/;

async function newCtx(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(u => GA_HOST_RE.test(u.hostname), route => {
    const req = route.request();
    gaHandled.push(req.method() + ' ' + req.url());
    if (req.url().includes('/gtag/js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* e2e base-currency: gtag.js stub */' });
    collectHits.push(req.url() + ' ' + (req.postData() || ''));
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.route(u => SUPA_HOST_RE.test(u.hostname), route => {
    const req = route.request();
    supabaseHandled.push(req.method() + ' ' + req.url());
    if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    supabaseWrites.push(req.method() + ' ' + req.url());
    return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"blocked by base-currency e2e"}' });
  });
  await ctx.addInitScript(() => {
    window.__consoleErrors = [];
    window.__wsAttempts = [];
    window.WebSocket = class {
      constructor(url) { window.__wsAttempts.push(String(url)); this.readyState = 3; }
      addEventListener() {} removeEventListener() {} send() {} close() {}
      set onopen(v) {} set onclose(v) {} set onerror(v) {} set onmessage(v) {}
    };
  });
  const page = await ctx.newPage();
  page.on('request', req => {
    let h; try { const u = new URL(req.url()); if (u.protocol !== 'http:' && u.protocol !== 'https:') return; h = u.hostname; } catch (e) { return; }
    allRequests.push({ url: req.url(), method: req.method() });
    if (SUPA_HOST_RE.test(h)) supabaseSeen.push(req.method() + ' ' + req.url());
    else if (GA_HOST_RE.test(h)) gaSeen.push(req.method() + ' ' + req.url());
  });
  page.on('console', m => { if (m.type() === 'error') page.evaluate(t => window.__consoleErrors.push(t), m.text()).catch(() => {}); });
  page.on('pageerror', e => { fails.push('PAGEERROR: ' + e.message); FAIL++; });
  return { ctx, page };
}

async function jsErrors(page) {
  return page.evaluate(() => (window.__consoleErrors || []).filter(e => !/favicon|esm\.sh|net::|Failed to load resource|WebSocket|realtime|googletagmanager|jsdelivr/i.test(e)));
}

// テスト専用の基準通貨切替（__setSettleState第6引数）で状態を流し込み、計算結果を整数minor unitで返す。
// USD等の非JPY基準は画面表示対象外のためrenderSettleは呼ばず、computeSettlements()の生の値だけを検証する。
async function runEngine(page, data) {
  return page.evaluate((d) => {
    window.__setSettleState(d.members, d.expenses, d.rates, d.unit, d.gid || 'e2e-base-currency-group', d.base);
    const s = window.computeSettlements();
    const names = d.members.map(m => m.name);
    const round = o => names.map(n => Math.round(o[n] || 0));
    const sum = o => names.reduce((t, n) => t + (o[n] || 0), 0);
    return {
      settles: s.settles,
      settleInts: s.settles.every(x => Number.isInteger(x.amt)),
      bal: round(s.bal), paid: round(s.paid), owed: round(s.owed),
      total: Math.round(s.total),
      owedSumRaw: sum(s.owed), paidSumRaw: sum(s.paid), balSumRaw: sum(s.bal),
      missing: s.missing, ready: s.ready, canShare: s.canShare,
      hasFallback: s.hasFallback, hasExcluded: s.hasExcluded,
    };
  }, data);
}

// JPY後方互換用：ゴールデンと同じくrenderSettleまで実行しDOM表示も取る（省略時＝JPYの確認に使う）
async function runJpyCase(page, data) {
  return page.evaluate((d) => {
    // baseを渡さない既存5引数呼び出し（後方互換経路そのもの）
    window.__setSettleState(d.members, d.expenses, d.rates, d.unit, d.gid || 'e2e-base-currency-group');
    window.renderSettle();
    const s = window.computeSettlements();
    const names = d.members.map(m => m.name);
    const round = o => names.map(n => Math.round(o[n] || 0));
    const rows = sel => [...document.querySelectorAll(sel + ' tbody tr')].map(tr => [...tr.children].map(td => td.textContent));
    return { settles: s.settles, bal: round(s.bal), paid: round(s.paid), owed: round(s.owed), total: Math.round(s.total), missing: s.missing, ready: s.ready, balanceRows: rows('#s-balance table') };
  }, data);
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const BASE = `http://localhost:${PORT}/ja/`;
  const browser = await chromium.launch();
  const { ctx, page } = await newCtx(browser);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.computeSettlements === 'function' && typeof window.__setSettleState === 'function', { timeout: 15000 });
  await page.evaluate(() => {
    document.getElementById('p-intro').classList.remove('show');
    document.getElementById('p-group').classList.remove('show');
    document.getElementById('p-main').classList.add('show');
    document.querySelectorAll('.tab').forEach(t => t.style.display = 'none');
    document.getElementById('t-settle').style.display = 'block';
  });

  // ---------- U1. USDのみ・均等割り ----------
  // 手計算：10.00 USD=1000セント/3人 → 333セントずつ・余り1セントは登録順先頭のまさとへ → 334/333/333。
  // まさと差額+666、たろう・はなこ各−333 → 333セント×2本。USDは基準通貨自身なのでレート入力不要。
  {
    const r = await runEngine(page, { members: M3, expenses: [exp(1, 'まさと', 10, 'USD', B3)], rates: {}, unit: 1, base: 'USD' });
    deep('[U1] 負担（セント：余り1は登録順先頭へ）', r.owed, [334, 333, 333]);
    deep('[U1] 立替（セント）', r.paid, [1000, 0, 0]);
    deep('[U1] 差額（セント）', r.bal, [666, -333, -333]);
    deep('[U1] 送金（333セント×2本・順序固定）', r.settles, [
      { from: 'たろう', to: 'まさと', amt: 333 },
      { from: 'はなこ', to: 'まさと', amt: 333 },
    ]);
    ok('[U1] 合計1000セント', r.total === 1000, String(r.total));
    deep('[U1] USDレート入力不要（missing空）', r.missing, []);
    ok('[U1] ready=true・共有可能相当', r.ready === true && r.canShare === true, '');
    ok('[U1] 送金額は整数セント', r.settleInts, JSON.stringify(r.settles));
  }

  // ---------- U2. 割り切れないセント（34%/33%/33%・最大剰余法） ----------
  // 手計算：10.01 USD=1001セント。340.34/330.33/330.33 → 切捨て340/330/330・余り1。
  // 剰余340/330/330で最大のまさとへ → 341/330/330（計1001セント。1セントも消失・増加しない）。
  {
    const PCT = [{ member: 'まさと', share_permille: 340 }, { member: 'たろう', share_permille: 330 }, { member: 'はなこ', share_permille: 330 }];
    const r = await runEngine(page, {
      members: M3, rates: {}, unit: 1, base: 'USD',
      expenses: [exp(1, 'まさと', 10.01, 'USD', B3, { split_mode: 'percentage', split_details: PCT })],
    });
    deep('[U2] 負担（最大剰余法：余りはまさとへ）', r.owed, [341, 330, 330]);
    ok('[U2] 負担合計がちょうど1001セント（丸め表示値）', r.owed.reduce((a, b) => a + b, 0) === 1001, JSON.stringify(r.owed));
    ok('[U2] 負担合計の生値も1001セントに一致（浮動小数誤差は最小単位未満）', Math.abs(r.owedSumRaw - 1001) < 0.005, String(r.owedSumRaw));
    ok('[U2] 合計1001セント（消失・増加なし）', r.total === 1001, String(r.total));
    deep('[U2] 差額', r.bal, [660, -330, -330]);
    deep('[U2] 送金', r.settles, [
      { from: 'たろう', to: 'まさと', amt: 330 },
      { from: 'はなこ', to: 'まさと', amt: 330 },
    ]);
  }

  // ---------- U3. 複数支払い・相互立替（4人・3人が立替） ----------
  // 手計算：80+50+70=200 USD=20000セント/4人 → 各負担5000セント。
  // まさと+3000、たろう0、はなこ+2000、よしお−5000 → よしお→まさと3000、よしお→はなこ2000。
  {
    const r = await runEngine(page, {
      members: M4, rates: {}, unit: 1, base: 'USD',
      expenses: [exp(1, 'まさと', 80, 'USD', B4), exp(2, 'たろう', 50, 'USD', B4), exp(3, 'はなこ', 70, 'USD', B4)],
    });
    deep('[U3] 立替（セント）', r.paid, [8000, 5000, 7000, 0]);
    deep('[U3] 負担（各5000セント）', r.owed, [5000, 5000, 5000, 5000]);
    deep('[U3] 差額が＋/0/＋/−に分かれる', r.bal, [3000, 0, 2000, -5000]);
    deep('[U3] 送金（大きい債権から・2本）', r.settles, [
      { from: 'よしお', to: 'まさと', amt: 3000 },
      { from: 'よしお', to: 'はなこ', amt: 2000 },
    ]);
    const senders = new Set(r.settles.map(s => s.from)), receivers = new Set(r.settles.map(s => s.to));
    ok('[U3] 循環送金なし（送金元と送金先が重複しない）', [...senders].every(n => !receivers.has(n)), JSON.stringify(r.settles));
    ok('[U3] 債権総額5000セント＝送金総額', r.settles.reduce((s, x) => s + x.amt, 0) === 5000, '');
    ok('[U3] 差額0のたろうは送金に登場しない', !senders.has('たろう') && !receivers.has('たろう'), '');
  }

  // ---------- U4. JPY混在（1 JPY = 0.0068 USD。テスト内固定レート・本番レート不使用） ----------
  // 手計算：USD 10.00（1000セント）→ 334/333/333。JPY 1000円 → 0.0068×100=680セント、配分334/333/333円
  //  → 227.12/226.44/226.44セント。
  //  負担：まさと561.12→561、たろう559.44→559、はなこ559.44→559。
  //  差額：まさと+438.88→439、たろう+120.56→121、はなこ−559.44→−559。
  //  送金：はなこ→まさと438.88→439セント、はなこ→たろう120.56→121セント。合計1680セント。
  {
    const r = await runEngine(page, {
      members: M3, rates: { JPY: 0.0068 }, unit: 1, base: 'USD',
      expenses: [exp(1, 'まさと', 10, 'USD', B3), exp(2, 'たろう', 1000, 'JPY', B3)],
    });
    deep('[U4] 立替（USD1000セント・JPY→680セント）', r.paid, [1000, 680, 0]);
    deep('[U4] 負担（セント換算・四捨五入表示値）', r.owed, [561, 559, 559]);
    deep('[U4] 差額', r.bal, [439, 121, -559]);
    deep('[U4] 送金（1セント単位・行ごと四捨五入）', r.settles, [
      { from: 'はなこ', to: 'まさと', amt: 439 },
      { from: 'はなこ', to: 'たろう', amt: 121 },
    ]);
    ok('[U4] 合計1680セント', r.total === 1680, String(r.total));
    deep('[U4] missing空（USDは自国通貨扱い・JPYはレートあり）', r.missing, []);
    ok('[U4] 送金額は整数セント', r.settleInts, JSON.stringify(r.settles));
  }
  {
    // U4m：JPYレートなし → missing=['JPY']（USDは基準通貨なので不足にならない）
    const r = await runEngine(page, {
      members: M3, rates: {}, unit: 1, base: 'USD',
      expenses: [exp(1, 'まさと', 10, 'USD', B3), exp(2, 'たろう', 1000, 'JPY', B3)],
    });
    deep('[U4m] 不足通貨はJPYのみ', r.missing, ['JPY']);
    ok('[U4m] ready=false・共有不可', r.ready === false && r.canShare === false, '');
    deep('[U4m] 送金なし', r.settles, []);
  }

  // ---------- U5. EUR混在（1 EUR = 1.08 USD。テスト内固定レート） ----------
  // 手計算：EUR 50.00=5000ユーロセント → 1667/1667/1666、×1.08 → 5400セント立替、
  //  負担18.0036/18.0036/17.9928ドル=1800.36/1800.36/1799.28セント。
  //  USD 20.00=2000セント → 667/667/666。
  //  負担計：2467.36→2467 / 2467.36→2467 / 2465.28→2465。
  //  差額：まさと+2932.64→2933、たろう−467.36→−467、はなこ−2465.28→−2465。
  //  送金：はなこ→まさと2465.28→2465、たろう→まさと467.36→467。合計7400セント。
  {
    const r = await runEngine(page, {
      members: M3, rates: { EUR: 1.08 }, unit: 1, base: 'USD',
      expenses: [exp(1, 'まさと', 50, 'EUR', B3), exp(2, 'たろう', 20, 'USD', B3)],
    });
    deep('[U5] 立替（EUR→5400セント・USD2000セント）', r.paid, [5400, 2000, 0]);
    deep('[U5] 負担（セント）', r.owed, [2467, 2467, 2465]);
    deep('[U5] 差額', r.bal, [2933, -467, -2465]);
    deep('[U5] 送金', r.settles, [
      { from: 'はなこ', to: 'まさと', amt: 2465 },
      { from: 'たろう', to: 'まさと', amt: 467 },
    ]);
    ok('[U5] 合計7400セント', r.total === 7400, String(r.total));
    deep('[U5] missing空', r.missing, []);
  }

  // ---------- U6. 丸め単位（同一データ・roundUnit=1/10/100） ----------
  // 手計算：10.05 USD=1005セント/3人 → 各335セント。まさと+670、たろう・はなこ各−335。
  //  1セント単位：335×2本／10セント単位：33.5→34→340×2本／1ドル（100セント）単位：3.35→3→300×2本。
  {
    const D = [exp(1, 'まさと', 10.05, 'USD', B3)];
    const r1 = await runEngine(page, { members: M3, expenses: D, rates: {}, unit: 1, base: 'USD' });
    deep('[U6] 1セント単位の送金', r1.settles, [
      { from: 'たろう', to: 'まさと', amt: 335 },
      { from: 'はなこ', to: 'まさと', amt: 335 },
    ]);
    const r10 = await runEngine(page, { members: M3, expenses: D, rates: {}, unit: 10, base: 'USD' });
    deep('[U6] 10セント単位の送金（33.5→34の四捨五入で340）', r10.settles, [
      { from: 'たろう', to: 'まさと', amt: 340 },
      { from: 'はなこ', to: 'まさと', amt: 340 },
    ]);
    deep('[U6] 10セント単位でも差額は丸め前の正確な値', r10.bal, [670, -335, -335]);
    const r100 = await runEngine(page, { members: M3, expenses: D, rates: {}, unit: 100, base: 'USD' });
    deep('[U6] 1ドル（100セント）単位の送金（335→300）', r100.settles, [
      { from: 'たろう', to: 'まさと', amt: 300 },
      { from: 'はなこ', to: 'まさと', amt: 300 },
    ]);
    ok('[U6] 全単位で送金額は各単位の倍数の整数セント',
      r1.settles.every(s => s.amt % 1 === 0) && r10.settles.every(s => s.amt % 10 === 0) && r100.settles.every(s => s.amt % 100 === 0), '');
  }

  // ---------- U7. 欠損レート ----------
  {
    const r = await runEngine(page, {
      members: M3, rates: {}, unit: 1, base: 'USD',
      expenses: [exp(1, 'まさと', 50, 'EUR', B3), exp(2, 'たろう', 90000, 'KRW', B3), exp(3, 'はなこ', 100, 'USD', B3)],
    });
    deep('[U7] 不足通貨がEUR・KRWの2件（出現順）', r.missing, ['EUR', 'KRW']);
    ok('[U7] ready=false', r.ready === false, '');
    deep('[U7] 送金リストは空', r.settles, []);
    ok('[U7] 共有不可相当（canShare=false）', r.canShare === false, '');
  }

  // ---------- U8. JPY後方互換 ----------
  // 同じ切替機構で'JPY'を明示し、既存JPYゴールデンの主要ケース（C1相当・C5相当）と同値になることを確認。
  // 既存ゴールデン92件そのものは owesum_jpy_golden_e2e.js を無改変のまま別途92/92で実行する。
  {
    const r = await runEngine(page, { members: M3, expenses: [exp(1, 'まさと', 1000, 'JPY', B3)], rates: {}, unit: 1, base: 'JPY' });
    deep('[U8] C1相当：負担', r.owed, [334, 333, 333]);
    deep('[U8] C1相当：送金', r.settles, [
      { from: 'たろう', to: 'まさと', amt: 333 },
      { from: 'はなこ', to: 'まさと', amt: 333 },
    ]);
    ok('[U8] C1相当：合計1000円', r.total === 1000, String(r.total));
  }
  {
    const r = await runEngine(page, {
      members: M3, rates: { USD: 150, THB: 4.3 }, unit: 1, base: 'JPY',
      expenses: [exp(1, 'まさと', 100, 'USD', B3), exp(2, 'たろう', 1000, 'THB', B3), exp(3, 'はなこ', 3000, 'JPY', B3)],
    });
    deep('[U8] C5相当：立替（円）', r.paid, [15000, 4300, 3000]);
    deep('[U8] C5相当：負担（円）', r.owed, [7434, 7433, 7433]);
    deep('[U8] C5相当：差額', r.bal, [7566, -3133, -4433]);
    deep('[U8] C5相当：送金', r.settles, [
      { from: 'はなこ', to: 'まさと', amt: 4433 },
      { from: 'たろう', to: 'まさと', amt: 3133 },
    ]);
    ok('[U8] C5相当：合計22300円', r.total === 22300, String(r.total));
  }
  {
    // 5引数（base省略）の既存呼び出しがそのままJPYで動く後方互換＋DOM表示（円）も従来どおり
    const r = await runJpyCase(page, { members: M3, expenses: [exp(1, 'まさと', 1000, 'JPY', B3)], rates: {}, unit: 1 });
    deep('[U8] 5引数呼び出し（base省略）でもJPY計算', { owed: r.owed, total: r.total }, { owed: [334, 333, 333], total: 1000 });
    deep('[U8] 5引数呼び出しのDOM表示は従来の円表示', r.balanceRows, [
      ['まさと', '1,000円', '334円', '+666円'],
      ['たろう', '0円', '333円', '-333円'],
      ['はなこ', '0円', '333円', '-333円'],
    ]);
  }
  {
    // USDケースの直後に5引数で呼べば必ずJPYへ戻る（テスト間の状態漏れ防止）
    await runEngine(page, { members: M3, expenses: [exp(1, 'まさと', 10, 'USD', B3)], rates: {}, unit: 1, base: 'USD' });
    const r = await runJpyCase(page, { members: M3, expenses: [exp(1, 'まさと', 100, 'USD', B3)], rates: {}, unit: 1 });
    deep('[U8] base省略でJPYへ復帰（USD支払いはレート不足になる）', r.missing, ['USD']);
    ok('[U8] JPY復帰後はready=false（USDレート未設定のため）', r.ready === false, '');
  }

  // ---------- G. ガード（テスト専用経路の閉じ込め） ----------
  {
    ok('[G] BASE_CURRENCYはwindowへ公開されない', await page.evaluate(() => typeof window.BASE_CURRENCY === 'undefined'), '');
    ok('[G] 基準通貨を直接変更できるwindow関数は存在しない',
      await page.evaluate(() => typeof window.__setBaseCurrency === 'undefined' && typeof window.setBaseCurrency === 'undefined'), '');
    // 不正な基準通貨指定（小文字・空・非文字列）はすべてJPYへ戻る
    for (const bad of ['usd', '', 123]) {
      const r = await runEngine(page, { members: M3, expenses: [exp(1, 'まさと', 100, 'USD', B3)], rates: {}, unit: 1, base: bad });
      deep(`[G] 不正な基準通貨(${JSON.stringify(bad)})はJPY扱い（USDがレート不足）`, r.missing, ['USD']);
    }
  }

  // ---------- N. 通信の総合検証 ----------
  {
    const errs = await jsErrors(page);
    ok('[N] 全ケース通してコンソールエラーなし', errs.length === 0, errs.join('||'));
    ok('[N] Supabase宛の発行数＝横取り数（本番到達0件）', supabaseSeen.length === supabaseHandled.length, `seen=${supabaseSeen.length} handled=${supabaseHandled.length}`);
    ok('[N] Supabaseへの書込み0件（テストグループを本番に作らない）', supabaseWrites.length === 0, supabaseWrites.join('||'));
    ok('[N] Google宛の発行数＝横取り数（実送信0件）', gaSeen.length === gaHandled.length, `seen=${gaSeen.length} handled=${gaHandled.length}`);
    ok('[N] 空gtagスタブのためcollect送信自体が0件', collectHits.length === 0, collectHits.join('||'));
    const allowedHosts = ['localhost', 'esm.sh', 'cdn.jsdelivr.net', 'www.googletagmanager.com', 'www.google-analytics.com', 'bqlrtohnxwpswgqttqbs.supabase.co'];
    const unexpected = [...new Set(allRequests.map(r => { try { return new URL(r.url).hostname; } catch (e) { return r.url; } }))].filter(h => !allowedHosts.includes(h));
    ok('[N] 許可リスト外への通信0件', unexpected.length === 0, unexpected.join('||'));
    // 秘密値漏えい：外部（localhost以外）へのリクエストURLにグループID・名前が含まれない
    const externalUrls = allRequests.filter(r => { try { return new URL(r.url).hostname !== 'localhost'; } catch (e) { return true; } }).map(r => r.url).join('\n');
    const secrets = ['e2e-base-currency-group', 'まさと', 'たろう', 'はなこ', 'よしお', encodeURIComponent('まさと')];
    const leaked = secrets.filter(s => externalUrls.includes(s));
    ok('[N] 外部リクエストにグループID・名前の漏えいなし', leaked.length === 0, leaked.join('||'));
    const dl = await page.evaluate(() => (window.dataLayer || []).filter(a => a && a[0] === 'event').map(a => a[1]));
    ok('[N] group_createdイベント0件', dl.filter(n => n === 'group_created').length === 0, dl.join(','));
  }

  await ctx.close();
  await browser.close();
  server.close();
  console.log(`\n==== 基準通貨エンジンE2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

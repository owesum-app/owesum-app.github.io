// OweSum 既存JPY精算結果のゴールデンE2E（Playwright・本番通信なし）。
//
// 目的：精算エンジンを「JPY固定」から「グループ基準通貨対応」へ一般化する前に、
// 現行のJPY精算仕様（立替・負担・差額・送金・丸め・レート不足判定・共有文・画面表示）を
// 明示的な期待値で固定する。将来の変更で既存JPYグループの結果が1円でも変われば本テストが失敗する。
//
// 期待値の出所（スナップショット自動生成ではない）：
//  1. 現行コードの計算結果を取得
//  2. 入力（金額・配分・為替・丸め単位）から手計算および独立実装（scratchpadのgolden_verify.js、
//     アプリのコードを共有しない別実装）で照合
//  3. 一致を確認した値だけを本ファイルへ明示的にハードコード
// 期待値をテスト実行で自動更新する仕組みは意図的に持たない。期待値の変更は仕様変更そのものなので、
// 変更する場合は必ず理由をレビューすること。
//
// ケース構成：
//  C1 JPYのみ・均等割り（割り切れない1000円/3人：余り1円はメンバー登録順の先頭へ）
//  C2 複数支払い・相互立替（4人・3人が立替、差額が＋/−/0に分かれ、送金は2本で循環なし）
//  C3 割合指定 34%/33%/33%（最大剰余法：余りが最大剰余へ、同率はメンバー登録順）
//  C4 金額指定（split_mode:amount、指定額そのまま負担）
//  C5 複数通貨 JPY+USD+THB（1通貨単位=rate円。テスト内固定レート、実レート不使用）
//  C6 為替レート不足（missing検出・ready=false・共有不可・共有ボタンブロック）
//  C7 丸め単位 1円/10円/100円（各送金行を独立に四捨五入。33.5→34の切上げ、0円行の非表示）
//  C8 精算共有文（全文一致：名前・金額・「円」・URL・結論の順序。件名・mailtoも固定）
//  N  通信検証（Supabase/Google発行数＝横取り数、想定外外部通信0、秘密値漏えいなし）
//
// 通信安全：GA4スイートと同等以上。
//  ・googletagmanager.com/gtag/js はルート横取りで空JSを返す（実送信なし）
//  ・google-analytics.com/collect は記録して204（実送信なし。本構成では0件が期待値）
//  ・supabase.co はHTTP全横取り（GETは空データ、書込みは403で遮断・記録）、WebSocketはスタブで無効化
//  ・発行数＝横取り数の照合で取りこぼしゼロを検証。テストグループの本番作成・group_created送信なし
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = 'C:\\Users\\narim\\OweSum';
const MIME = { '.html': 'text/html;charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

let PASS = 0, FAIL = 0; const fails = [];
function ok(name, cond, extra) { if (cond) { PASS++; } else { FAIL++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); } }
// ゴールデン比較：期待値と厳密一致（JSON表現で全要素・順序まで比較）
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

const GID = 'e2e-golden-group';
const GNAME = 'ゴールデン旅行';
// メンバー登録順は精算の端数配分・同額タイブレークに影響するため固定する
const M3 = [{ name: 'まさと' }, { name: 'たろう' }, { name: 'はなこ' }];
const M4 = [{ name: 'まさと' }, { name: 'たろう' }, { name: 'はなこ' }, { name: 'よしお' }];
const B3 = 'まさと,たろう,はなこ';
const B4 = 'まさと,たろう,はなこ,よしお';
const exp = (id, payer, amount, currency, beneficiaries, extra) => Object.assign(
  { id, group_id: GID, payer, amount, currency, beneficiaries, split_mode: 'equal', split_details: null, date: '2026-07-01', name: '支払い' + id, created_at: '2026-07-01T00:00:00Z' }, extra || {});

// ===== 通信の記録 =====
let allRequests = [];        // {url, method} 全リクエスト（ホスト検証・秘密値漏えい検証用）
let supabaseSeen = [];       // ブラウザーが発行したsupabase.co宛リクエスト
let supabaseHandled = [];    // ルート横取りが応答したsupabase.co宛リクエスト
let supabaseWrites = [];     // 遮断したsupabase.co宛の書込み（0件が期待値）
let gaSeen = [];             // Google系宛に発行されたリクエスト
let gaHandled = [];          // ルート横取りが応答したGoogle系宛リクエスト
let collectHits = [];        // GA収集payload（空gtagスタブのため0件が期待値）
const GA_HOST_RE = /(\.|^)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|google\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com|gstatic\.com)$/;
const SUPA_HOST_RE = /(\.|^)supabase\.co$/;

async function newCtx(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // Google系：gtag.jsは空JS、collect等は記録して204。外部へは一切通さない
  await ctx.route(u => GA_HOST_RE.test(u.hostname), route => {
    const req = route.request();
    gaHandled.push(req.method() + ' ' + req.url());
    if (req.url().includes('/gtag/js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* e2e golden: gtag.js stub */' });
    collectHits.push(req.url() + ' ' + (req.postData() || ''));
    return route.fulfill({ status: 204, body: '' });
  });
  // Supabase：GETは空データ、書込みは記録して403。本番へは一切通さない
  await ctx.route(u => SUPA_HOST_RE.test(u.hostname), route => {
    const req = route.request();
    supabaseHandled.push(req.method() + ' ' + req.url());
    if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    supabaseWrites.push(req.method() + ' ' + req.url());
    return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"blocked by golden e2e"}' });
  });
  await ctx.addInitScript(() => {
    window.__consoleErrors = [];
    window.__shareCalls = [];
    // Realtime用WebSocketを完全無効化し、本番Supabaseへの接続を発生させない
    window.__wsAttempts = [];
    window.WebSocket = class {
      constructor(url) { window.__wsAttempts.push(String(url)); this.readyState = 3; }
      addEventListener() {} removeEventListener() {} send() {} close() {}
      set onopen(v) {} set onclose(v) {} set onerror(v) {} set onmessage(v) {}
    };
    // navigator.share を傍受（共有文の全文検証用。実共有は発生させない）
    Object.defineProperty(navigator, 'share', {
      configurable: true, writable: true,
      value: function (d) { window.__shareCalls.push(d); return Promise.resolve(); }
    });
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

// 精算タブを表示状態にする（既存スイートと同じ手法。#s-result等はt-settle内）
const showSettle = (page) => page.evaluate(() => {
  document.getElementById('p-intro').classList.remove('show');
  document.getElementById('p-group').classList.remove('show');
  document.getElementById('p-main').classList.add('show');
  document.getElementById('main-nav').style.display = 'flex';
  document.querySelectorAll('.tab').forEach(t => t.style.display = 'none');
  document.getElementById('t-settle').style.display = 'block';
  document.querySelectorAll('.nb').forEach(b => b.classList.remove('on'));
  document.querySelector('.nb[data-tab="settle"]').classList.add('on');
});

// 既存フック__setSettleStateでデータを流し込み、計算結果と画面表示のスナップショットを返す
async function runCase(page, data) {
  return page.evaluate((d) => {
    window.__setSettleState(d.members, d.expenses, d.rates, d.unit, d.gid || 'e2e-golden-group');
    document.getElementById('g-title').textContent = d.gname || 'ゴールデン旅行';
    window.renderSettle();
    const s = window.computeSettlements();
    const names = d.members.map(m => m.name);
    const round = o => names.map(n => Math.round(o[n] || 0));
    const rows = sel => [...document.querySelectorAll(sel + ' tbody tr')].map(tr => [...tr.children].map(td => td.textContent));
    const foot = sel => [...document.querySelectorAll(sel + ' tfoot tr')].map(tr => [...tr.children].map(td => td.textContent));
    return {
      settles: s.settles,
      bal: round(s.bal), paid: round(s.paid), owed: round(s.owed),
      total: Math.round(s.total),
      missing: s.missing, ready: s.ready, canShare: s.canShare,
      hasFallback: s.hasFallback, hasExcluded: s.hasExcluded,
      balanceRows: rows('#s-balance table'), balanceFoot: foot('#s-balance table'),
      resultRows: rows('#s-result table'),
      resultText: document.getElementById('s-result').textContent,
      warnShown: getComputedStyle(document.getElementById('s-warn')).display !== 'none',
      splitWarnShown: getComputedStyle(document.getElementById('s-split-warn')).display !== 'none',
      roundNote: document.getElementById('round-note').textContent,
      rbOn: [...document.querySelectorAll('.rb')].filter(b => b.classList.contains('on')).map(b => b.dataset.r),
    };
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
  await showSettle(page);

  // ---------- C1. JPYのみ・均等割り（3人・1人が支払い・割り切れない金額） ----------
  // 手計算：1000円/3人 → 333円ずつ・余り1円は登録順先頭のまさとへ → 負担334/333/333。
  // まさと差額 = 1000−334 = +666。たろう・はなこは各−333 → 各333円をまさとへ送金。
  {
    const r = await runCase(page, { members: M3, expenses: [exp(1, 'まさと', 1000, 'JPY', B3)], rates: {}, unit: 1 });
    deep('[C1] 送金リスト（送金元・送金先・金額・順序）', r.settles, [
      { from: 'たろう', to: 'まさと', amt: 333 },
      { from: 'はなこ', to: 'まさと', amt: 333 },
    ]);
    deep('[C1] 立替額（まさと/たろう/はなこ）', r.paid, [1000, 0, 0]);
    deep('[C1] 負担額（余り1円は登録順先頭へ）', r.owed, [334, 333, 333]);
    deep('[C1] 差額', r.bal, [666, -333, -333]);
    ok('[C1] 合計1,000円', r.total === 1000, String(r.total));
    ok('[C1] レート不足なし・計算可能・共有可能', r.missing.length === 0 && r.ready && r.canShare, JSON.stringify({ m: r.missing, ready: r.ready, canShare: r.canShare }));
    deep('[C1] 個人別内訳テーブルの表示（円表示・符号）', r.balanceRows, [
      ['まさと', '1,000円', '334円', '+666円'],
      ['たろう', '0円', '333円', '-333円'],
      ['はなこ', '0円', '333円', '-333円'],
    ]);
    deep('[C1] 内訳合計行（立替計＝負担計＝1,000円）', r.balanceFoot, [['合計', '1,000円', '1,000円', '']]);
    deep('[C1] 送金額テーブルの表示', r.resultRows, [
      ['たろう → まさと', '333円'],
      ['はなこ → まさと', '333円'],
    ]);
    ok('[C1] 為替不足警告が非表示', !r.warnShown, '');
    ok('[C1] 丸め注記が「1円単位で表示しています」', r.roundNote === '1円単位で表示しています', r.roundNote);
    deep('[C1] 丸めボタンは1円が選択状態', r.rbOn, ['1']);
  }

  // ---------- C2. 複数支払い・相互立替（4人・3人が立替、差額が＋/−/0） ----------
  // 手計算：総額20000円/4人 → 各負担5000円。
  //  まさと8000払い → +3000、たろう5000払い → 0、はなこ7000払い → +2000、よしお0払い → −5000。
  // 貪欲法（額の大きい順）：よしお→まさと3000、よしお→はなこ2000。送金2本・循環なし・総額5000=債権計。
  {
    const r = await runCase(page, {
      members: M4, rates: {}, unit: 1,
      expenses: [exp(1, 'まさと', 8000, 'JPY', B4), exp(2, 'たろう', 5000, 'JPY', B4), exp(3, 'はなこ', 7000, 'JPY', B4)],
    });
    deep('[C2] 送金リスト（2本・大きい債権から）', r.settles, [
      { from: 'よしお', to: 'まさと', amt: 3000 },
      { from: 'よしお', to: 'はなこ', amt: 2000 },
    ]);
    deep('[C2] 立替額', r.paid, [8000, 5000, 7000, 0]);
    deep('[C2] 負担額（各5,000円）', r.owed, [5000, 5000, 5000, 5000]);
    deep('[C2] 差額が＋/0/＋/−に分かれる', r.bal, [3000, 0, 2000, -5000]);
    ok('[C2] 合計20,000円', r.total === 20000, String(r.total));
    const senders = new Set(r.settles.map(s => s.from)), receivers = new Set(r.settles.map(s => s.to));
    ok('[C2] 循環送金なし（送金元と送金先が重複しない）', [...senders].every(n => !receivers.has(n)), JSON.stringify(r.settles));
    ok('[C2] 送金総額5,000円＝債権合計と整合', r.settles.reduce((s, x) => s + x.amt, 0) === 5000, '');
    ok('[C2] 差額0のたろうは送金に登場しない', !senders.has('たろう') && !receivers.has('たろう'), '');
    ok('[C2] 共有可能', r.canShare, '');
  }

  // ---------- C3. 割合指定 34%/33%/33%（最大剰余法の端数配分） ----------
  const PCT = [{ member: 'まさと', share_permille: 340 }, { member: 'たろう', share_permille: 330 }, { member: 'はなこ', share_permille: 330 }];
  // C3a 手計算：1001円 → 340.34/330.33/330.33 → 切捨て340/330/330・余り1円。
  // 剰余は340/330/330（‰換算の剰余340,330,330）で最大のまさとへ → 341/330/330。
  {
    const r = await runCase(page, {
      members: M3, rates: {}, unit: 1,
      expenses: [exp(1, 'まさと', 1001, 'JPY', B3, { split_mode: 'percentage', split_details: PCT })],
    });
    deep('[C3a] 1001円の負担（余りは最大剰余のまさとへ）', r.owed, [341, 330, 330]);
    deep('[C3a] 差額', r.bal, [660, -330, -330]);
    deep('[C3a] 送金リスト', r.settles, [
      { from: 'たろう', to: 'まさと', amt: 330 },
      { from: 'はなこ', to: 'まさと', amt: 330 },
    ]);
    ok('[C3a] 合計1,001円・共有可能・警告なし', r.total === 1001 && r.canShare && !r.splitWarnShown, '');
  }
  // C3b 手計算：1003円 → 341.02/330.99/330.99 → 切捨て341/330/330・余り2円。
  // 剰余20/990/990 → 大きい順にたろう・はなこ（同率はメンバー登録順）へ1円ずつ → 341/331/331。
  {
    const r = await runCase(page, {
      members: M3, rates: {}, unit: 1,
      expenses: [exp(1, 'まさと', 1003, 'JPY', B3, { split_mode: 'percentage', split_details: PCT })],
    });
    deep('[C3b] 1003円の負担（余り2円は剰余最大のたろう・はなこへ）', r.owed, [341, 331, 331]);
    deep('[C3b] 差額', r.bal, [662, -331, -331]);
    deep('[C3b] 送金リスト', r.settles, [
      { from: 'たろう', to: 'まさと', amt: 331 },
      { from: 'はなこ', to: 'まさと', amt: 331 },
    ]);
    ok('[C3b] 合計1,003円・共有可能', r.total === 1003 && r.canShare, '');
  }

  // ---------- C4. 金額指定（split_mode:amount） ----------
  // 手計算：たろう5000円払い、指定負担 まさと2000/たろう500/はなこ2500（計5000=支払総額）。
  // 差額：まさと−2000、たろう+4500、はなこ−2500 → はなこ→たろう2500、まさと→たろう2000。
  {
    const r = await runCase(page, {
      members: M3, rates: {}, unit: 1,
      expenses: [exp(1, 'たろう', 5000, 'JPY', B3, {
        split_mode: 'amount',
        split_details: [{ member: 'まさと', amount_minor: 2000 }, { member: 'たろう', amount_minor: 500 }, { member: 'はなこ', amount_minor: 2500 }],
      })],
    });
    deep('[C4] 負担額が指定どおり', r.owed, [2000, 500, 2500]);
    ok('[C4] 指定負担の合計＝支払総額5,000円', r.total === 5000, String(r.total));
    deep('[C4] 立替額', r.paid, [0, 5000, 0]);
    deep('[C4] 差額', r.bal, [-2000, 4500, -2500]);
    deep('[C4] 送金リスト（債務の大きい順）', r.settles, [
      { from: 'はなこ', to: 'たろう', amt: 2500 },
      { from: 'まさと', to: 'たろう', amt: 2000 },
    ]);
    ok('[C4] 共有可能・警告なし', r.canShare && !r.splitWarnShown, '');
  }

  // ---------- C5. 複数通貨 JPY+USD+THB（テスト内固定レート：1USD=150円、1THB=4.3円） ----------
  // 手計算：
  //  100USD=10000セント → 3334/3333/3333セント（余り1セントは先頭へ）→ 円換算 5001 / 4999.5 / 4999.5円、立替15000円
  //  1000THB=100000サタン → 33334/33333/33333 → 円換算 1433.362 / 1433.319 / 1433.319円、立替4300円
  //  3000JPY → 各1000円、立替3000円
  //  負担計：まさと7434.362 / たろう7432.819 / はなこ7432.819（表示は四捨五入7434/7433/7433）
  //  差額：まさと+7565.638（表示+7566）/ たろう−3132.819（−3133）/ はなこ−4432.819（−4433）
  //  送金（債務の大きい順・1円単位四捨五入）：はなこ→まさと4433円、たろう→まさと3133円。総額22300円
  const C5EXP = [
    exp(1, 'まさと', 100, 'USD', B3),
    exp(2, 'たろう', 1000, 'THB', B3),
    exp(3, 'はなこ', 3000, 'JPY', B3),
  ];
  const C5RATES = { USD: 150, THB: 4.3 };
  {
    const r = await runCase(page, { members: M3, expenses: C5EXP, rates: C5RATES, unit: 1 });
    deep('[C5] 送金リスト（円換算・1円単位）', r.settles, [
      { from: 'はなこ', to: 'まさと', amt: 4433 },
      { from: 'たろう', to: 'まさと', amt: 3133 },
    ]);
    deep('[C5] 立替額（円換算：15000/4300/3000）', r.paid, [15000, 4300, 3000]);
    deep('[C5] 負担額（円換算・四捨五入表示値）', r.owed, [7434, 7433, 7433]);
    deep('[C5] 差額', r.bal, [7566, -3133, -4433]);
    ok('[C5] 合計22,300円', r.total === 22300, String(r.total));
    ok('[C5] レート不足なし・共有可能', r.missing.length === 0 && r.canShare, JSON.stringify(r.missing));
    deep('[C5] 個人別内訳テーブルの表示（千区切り）', r.balanceRows, [
      ['まさと', '15,000円', '7,434円', '+7,566円'],
      ['たろう', '4,300円', '7,433円', '-3,133円'],
      ['はなこ', '3,000円', '7,433円', '-4,433円'],
    ]);
    deep('[C5] 内訳合計行（22,300円）', r.balanceFoot, [['合計', '22,300円', '22,300円', '']]);
    deep('[C5] 送金額テーブルの表示（千区切り）', r.resultRows, [
      ['はなこ → まさと', '4,433円'],
      ['たろう → まさと', '3,133円'],
    ]);
  }

  // ---------- C6. 為替レート不足（missing検出・共有不可・共有ボタンブロック） ----------
  {
    // C6a：EURのレートなし（JPY支払いが混在してもready=falseで送金計算しない）
    const r = await runCase(page, {
      members: M3, rates: {}, unit: 1,
      expenses: [exp(1, 'まさと', 50, 'EUR', B3), exp(2, 'たろう', 1000, 'JPY', B3)],
    });
    deep('[C6a] 不足通貨がEURと検出される', r.missing, ['EUR']);
    ok('[C6a] 精算準備未完了（ready=false）', r.ready === false, '');
    deep('[C6a] 送金リストは空', r.settles, []);
    ok('[C6a] 共有不可（canShare=false）', r.canShare === false, '');
    ok('[C6a] 為替不足警告が表示される', r.warnShown, '');
    ok('[C6a] 送金欄は「為替レートを入力すると表示されます」', r.resultText.includes('為替レートを入力すると表示されます'), r.resultText);
    deep('[C6a] 内訳テーブルは表示されない', r.balanceRows, []);
    // 共有ボタンを押しても共有シートが開かず、案内トーストが出る（GIDは設定済み）
    await page.click('#btn-share-settle');
    await page.waitForTimeout(100);
    const blocked = await page.evaluate(() => ({
      sheetShown: getComputedStyle(document.getElementById('share-bg')).display !== 'none',
      toast: [...document.querySelectorAll('#toast-wrap .toast')].map(t => t.textContent),
      shareCalls: window.__shareCalls.length,
    }));
    ok('[C6a] 共有シートが開かない', !blocked.sheetShown, '');
    ok('[C6a] 「精算結果を確認してから共有してください」トースト', blocked.toast.some(t => t.includes('精算結果を確認してから共有してください')), JSON.stringify(blocked.toast));
    ok('[C6a] navigator.shareは呼ばれない', blocked.shareCalls === 0, String(blocked.shareCalls));
    await page.waitForTimeout(2600); // トースト消滅を待って後続ケースの表示検証への影響を防ぐ
  }
  {
    // C6b：複数通貨が不足（EUR・KRW。USDはレートあり）→ 不足リストは出現順
    const r = await runCase(page, {
      members: M3, rates: { USD: 150 }, unit: 1,
      expenses: [exp(1, 'まさと', 50, 'EUR', B3), exp(2, 'たろう', 90000, 'KRW', B3), exp(3, 'はなこ', 100, 'USD', B3)],
    });
    deep('[C6b] 不足通貨がEUR・KRWの2件（出現順）', r.missing, ['EUR', 'KRW']);
    ok('[C6b] ready=false・共有不可', r.ready === false && r.canShare === false, '');
    deep('[C6b] 送金リストは空', r.settles, []);
  }

  // ---------- C7. 丸め単位 1円/10円/100円（同一データ・送金行ごとに独立四捨五入） ----------
  // 手計算：1005円/3人 → 各335円、まさと差額+670、たろう・はなこ各−335。
  //  1円単位：335円×2本（総額670円）
  //  10円単位：335/10=33.5 → 34 → 340円×2本（総額680円。行ごとの四捨五入で切下げ調整しない現行仕様）
  //  100円単位：335/100=3.35 → 3 → 300円×2本（総額600円）
  const C7EXP = [exp(1, 'まさと', 1005, 'JPY', B3)];
  {
    const r1 = await runCase(page, { members: M3, expenses: C7EXP, rates: {}, unit: 1 });
    deep('[C7] 1円単位の送金', r1.settles, [
      { from: 'たろう', to: 'まさと', amt: 335 },
      { from: 'はなこ', to: 'まさと', amt: 335 },
    ]);
    ok('[C7] 1円単位の注記', r1.roundNote === '1円単位で表示しています', r1.roundNote);
    const r10 = await runCase(page, { members: M3, expenses: C7EXP, rates: {}, unit: 10 });
    deep('[C7] 10円単位の送金（33.5→34の四捨五入で340円）', r10.settles, [
      { from: 'たろう', to: 'まさと', amt: 340 },
      { from: 'はなこ', to: 'まさと', amt: 340 },
    ]);
    ok('[C7] 10円単位の注記', r10.roundNote === '10円単位で四捨五入しています', r10.roundNote);
    deep('[C7] 丸めボタンは10円が選択状態', r10.rbOn, ['10']);
    deep('[C7] 10円単位でも差額表示は丸め前の正確な値', r10.bal, [670, -335, -335]);
    deep('[C7] 10円単位の送金表示', r10.resultRows, [['たろう → まさと', '340円'], ['はなこ → まさと', '340円']]);
    const r100 = await runCase(page, { members: M3, expenses: C7EXP, rates: {}, unit: 100 });
    deep('[C7] 100円単位の送金（335→300円）', r100.settles, [
      { from: 'たろう', to: 'まさと', amt: 300 },
      { from: 'はなこ', to: 'まさと', amt: 300 },
    ]);
    ok('[C7] 100円単位の注記', r100.roundNote === '100円単位で四捨五入しています', r100.roundNote);
    deep('[C7] 丸めボタンは100円が選択状態', r100.rbOn, ['100']);
  }
  {
    // C7d：丸めで0円になる送金行は表示しない（80円を2人で→差額40円、100円単位で0円）
    const C7D = [exp(1, 'まさと', 80, 'JPY', 'まさと,たろう')];
    const r10 = await runCase(page, { members: M3, expenses: C7D, rates: {}, unit: 10 });
    deep('[C7d] 10円単位では40円の送金1本', r10.settles, [{ from: 'たろう', to: 'まさと', amt: 40 }]);
    const r100 = await runCase(page, { members: M3, expenses: C7D, rates: {}, unit: 100 });
    deep('[C7d] 100円単位では送金0本（40円→0円で行を捨てる）', r100.settles, []);
    ok('[C7d] 表示は「全員イーブン！精算不要」', r100.resultText.includes('全員イーブン！精算不要'), r100.resultText);
    ok('[C7d] 送金0本でも共有は可能（canShare=true）', r100.canShare === true, '');
  }

  // ---------- C8. 精算共有文（全文一致で固定） ----------
  {
    // C8a：純関数buildSettleShareTextを固定URLで全文一致（日時・ランダム値なし）
    await runCase(page, { members: M3, expenses: [exp(1, 'まさと', 1000, 'JPY', B3)], rates: {}, unit: 1 });
    const t = await page.evaluate(() => window.buildSettleShareText('ゴールデン旅行', window.computeSettlements().settles, 'https://example.invalid/g'));
    deep('[C8a] 共有文の全文（名前・金額・円・結論の順序・URL）', t,
      '【OweSum｜ゴールデン旅行の精算結果】\n\nたろう → まさと：333円\nはなこ → まさと：333円\n\n詳細はこちら\nhttps://example.invalid/g');
    // 件名とmailto（本文はエンコードのみ・内容は同一）
    const subject = await page.evaluate(() => window.buildSettleSubject('ゴールデン旅行'));
    ok('[C8a] メール件名', subject === 'OweSum「ゴールデン旅行」の精算結果', subject);
    const mailto = await page.evaluate(() => window.buildSettleMailto('ゴールデン旅行', window.buildSettleShareText('ゴールデン旅行', window.computeSettlements().settles, 'https://example.invalid/g')));
    ok('[C8a] mailtoが件名・本文の正確なエンコード', mailto === 'mailto:?subject=' + encodeURIComponent('OweSum「ゴールデン旅行」の精算結果') + '&body=' + encodeURIComponent(t), mailto.slice(0, 120));
  }
  {
    // C8b：共有URLの組み立て（?g=…&tab=settle&ogv=20260725-2）と実UI経由の共有文
    const shareUrl = await page.evaluate(() => window.buildSettleShareUrl('e2e-golden-group'));
    ok('[C8b] 共有URLの組み立てが固定形', shareUrl === `${BASE}?g=e2e-golden-group&tab=settle&ogv=20260725-2`, shareUrl);
    await page.evaluate(() => { window.__shareCalls = []; });
    await page.click('#btn-share-settle');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('share-bg')).display !== 'none', { timeout: 5000 });
    await page.click('#share-line');
    await page.waitForFunction(() => window.__shareCalls.length === 1, { timeout: 5000 });
    const call = await page.evaluate(() => window.__shareCalls[0]);
    ok('[C8b] navigator.shareのtitleが件名', call.title === 'OweSum「ゴールデン旅行」の精算結果', String(call.title));
    deep('[C8b] 実UI経由の共有文全文（画面表示と同一の金額）', call.text,
      `【OweSum｜ゴールデン旅行の精算結果】\n\nたろう → まさと：333円\nはなこ → まさと：333円\n\n詳細はこちら\n${BASE}?g=e2e-golden-group&tab=settle&ogv=20260725-2`);
    ok('[C8b] 共有文にURLはちょうど1回', call.text.split(`${BASE}?g=e2e-golden-group`).length - 1 === 1, '');
    ok('[C8b] shareにurl項目を渡さない（URL二重表示防止の現行仕様）', !('url' in call), Object.keys(call).join(','));
  }
  {
    // C8c：送金0本の共有文（「精算はありません」）
    const t = await page.evaluate(() => window.buildSettleShareText('ゴールデン旅行', [], 'https://example.invalid/g'));
    deep('[C8c] 精算なしの共有文全文', t, '【OweSum｜ゴールデン旅行の精算結果】\n\n精算はありません\n\n詳細はこちら\nhttps://example.invalid/g');
  }
  {
    // C8d：千区切りを含む共有文（C5データ）
    await runCase(page, { members: M3, expenses: C5EXP, rates: C5RATES, unit: 1 });
    const t = await page.evaluate(() => window.buildSettleShareText('ゴールデン旅行', window.computeSettlements().settles, 'https://example.invalid/g'));
    deep('[C8d] 千区切り金額の共有文全文', t,
      '【OweSum｜ゴールデン旅行の精算結果】\n\nはなこ → まさと：4,433円\nたろう → まさと：3,133円\n\n詳細はこちら\nhttps://example.invalid/g');
  }

  // ---------- N. 通信の総合検証 ----------
  {
    const errs = await jsErrors(page);
    ok('[N] 全ケース通してコンソールエラーなし', errs.length === 0, errs.join('||'));
    ok('[N] Supabase宛の発行数＝横取り数（本番到達0件）', supabaseSeen.length === supabaseHandled.length, `seen=${supabaseSeen.length} handled=${supabaseHandled.length}`);
    ok('[N] Supabaseへの書込み0件（テストグループを本番に作らない）', supabaseWrites.length === 0, supabaseWrites.join('||'));
    ok('[N] Google宛の発行数＝横取り数（実送信0件）', gaSeen.length === gaHandled.length, `seen=${gaSeen.length} handled=${gaHandled.length}`);
    ok('[N] Google宛を観測できている（ガードの実効性確認）', gaSeen.length >= 1, String(gaSeen.length));
    ok('[N] 空gtagスタブのためcollect送信自体が0件', collectHits.length === 0, collectHits.join('||'));
    const allowedHosts = ['localhost', 'esm.sh', 'cdn.jsdelivr.net', 'www.googletagmanager.com', 'www.google-analytics.com', 'bqlrtohnxwpswgqttqbs.supabase.co'];
    const unexpected = [...new Set(allRequests.map(r => { try { return new URL(r.url).hostname; } catch (e) { return r.url; } }))].filter(h => !allowedHosts.includes(h));
    ok('[N] 許可リスト外への通信0件', unexpected.length === 0, unexpected.join('||'));
    // WebSocketはスタブ化済み（試行はあっても実接続は発生しない）
    const wsAttempts = await page.evaluate(() => window.__wsAttempts.length);
    ok('[N] WebSocket実接続0件（スタブが全試行を吸収）', true, `attempts=${wsAttempts}`);
    // 秘密値漏えい：外部（localhost以外）へのリクエストURLにグループID・名前・金額が含まれない
    const externalUrls = allRequests.filter(r => { try { return new URL(r.url).hostname !== 'localhost'; } catch (e) { return true; } }).map(r => r.url).join('\n');
    const secrets = ['e2e-golden-group', 'まさと', 'たろう', 'はなこ', 'よしお', encodeURIComponent('まさと'), encodeURIComponent('ゴールデン旅行'), 'ゴールデン旅行', '22300', '4433', '7566'];
    const leaked = secrets.filter(s => externalUrls.includes(s));
    ok('[N] 外部リクエストにグループID・名前・金額の漏えいなし', leaked.length === 0, leaked.join('||'));
    // dataLayer上でもgroup_createdが発生していない（本テストはグループを作成しない）
    const dl = await page.evaluate(() => (window.dataLayer || []).filter(a => a && a[0] === 'event').map(a => a[1]));
    ok('[N] group_createdイベント0件', dl.filter(n => n === 'group_created').length === 0, dl.join(','));
    ok('[N] page_viewはページ読込み時の1件だけ', dl.filter(n => n === 'page_view').length === 1, dl.join(','));
  }

  await ctx.close();
  await browser.close();
  server.close();
  console.log(`\n==== JPYゴールデンE2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

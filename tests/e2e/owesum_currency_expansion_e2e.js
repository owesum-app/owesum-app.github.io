// OweSum 標準通貨拡充（2026-07-26）のE2E検証（Playwright・本番DBアクセスなし）。
// 検証範囲：
//  A. 標準通貨データ：一意性・必須通貨・既存22通貨維持・主要通貨の順序
//  B. 通貨検索：コード/日本語名/英語名/国名/記号、正規化（大小文字・全角半角・空白）、重複なし
//  C. 通貨選択UI：最近使った通貨・よく使われる通貨・その他の折りたたみ、既存/追加通貨の選択
//  D. 為替：追加通貨のレート入力→全期間再計算、未知コードでもクラッシュしない、小数桁
//  E. JSONバックアップ復元（旧v1・v2形式）
//  F. レイアウト（390x844 / 1280x800）・コンソールエラー
// 安全対策：Supabase RESTはPlaywrightのルート横取りでローカルの偽DBに完結させ、
// 想定外のリクエストは遮断して記録する。realtimeはWebSocketスタブで接続自体を発生させない。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = 'C:\\Users\\narim\\OweSum';
const MIME = { '.html': 'text/html;charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };
const SHOT = process.env.SHOT_DIR || path.join(__dirname, 'shots');
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

let PASS = 0, FAIL = 0; const fails = [];
function ok(name, cond, extra) { if (cond) { PASS++; } else { FAIL++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); } }

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

const GID = 'e2e-cur-group';
const GNAME = '通貨テスト';
const MEMBERS = [
  { id: 1, group_id: GID, name: 'まさと', created_at: '2026-07-26T00:00:01Z' },
  { id: 2, group_id: GID, name: 'たろう', created_at: '2026-07-26T00:00:02Z' },
  { id: 3, group_id: GID, name: 'はなこ', created_at: '2026-07-26T00:00:03Z' },
];

// ローカル完結の偽Supabase REST。GET/POSTのみ許可し、状態はメモリ上のstateに保持。
// それ以外のメソッド・想定外テーブルはviolationsに記録して遮断する。
function makeDb(initial) {
  const state = Object.assign({ groups: [{ id: GID, name: GNAME }], members: [], expenses: [], rates: [] }, initial || {});
  let idc = 1000;
  const violations = [];
  const handler = route => {
    const req = route.request();
    const url = new URL(req.url());
    const table = url.pathname.split('/').pop();
    const method = req.method();
    if (!(table in state)) { violations.push(method + ' ' + url.pathname); return route.fulfill({ status: 404, contentType: 'application/json', body: '[]' }); }
    if (method === 'GET') {
      let rows = state[table];
      for (const [k, v] of url.searchParams) { const m = /^eq\.(.*)$/.exec(v); if (m) rows = rows.filter(r => String(r[k]) === m[1]); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }
    if (method === 'POST') {
      const body = JSON.parse(req.postData() || 'null');
      const rows = Array.isArray(body) ? body : [body];
      const inserted = rows.map(r => Object.assign({ id: 'id-' + (idc++), created_at: new Date().toISOString() }, r));
      if (table === 'rates') {
        inserted.forEach(n => { state.rates = state.rates.filter(r => !(String(r.group_id) === String(n.group_id) && r.currency === n.currency)); });
      }
      state[table].push(...inserted);
      const accept = (req.headers()['accept'] || '');
      const out = accept.includes('pgrst.object') ? JSON.stringify(inserted[0]) : JSON.stringify(inserted);
      return route.fulfill({ status: 201, contentType: 'application/json', body: out });
    }
    violations.push(method + ' ' + url.pathname);
    return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"blocked by e2e"}' });
  };
  return { state, handler, violations };
}

async function newCtx(browser, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport });
  const db = makeDb(opts.db);
  // Supabaseホストへの通信：RESTは偽DB、その他（realtime等のHTTP）は遮断して記録
  await ctx.route('**bqlrtohnxwpswgqttqbs.supabase.co/**', route => { db.violations.push('OTHER ' + route.request().url()); return route.abort(); });
  await ctx.route('**/rest/v1/**', db.handler);
  await ctx.addInitScript(gid => { localStorage.setItem('narika_intro_seen_gids', JSON.stringify([gid])); }, GID);
  if (opts.recent) await ctx.addInitScript(r => { localStorage.setItem('narika_recent_curr', JSON.stringify(r)); }, opts.recent);
  await ctx.addInitScript(() => {
    // realtimeのWebSocket接続を発生させない（本番インフラへ一切アクセスしない）
    window.__consoleErrors = [];
    const FakeWS = function () {
      this.readyState = 3;
      const self = this;
      setTimeout(() => { if (self.onerror) self.onerror(new Event('error')); if (self.onclose) self.onclose({ code: 1006, reason: 'blocked by e2e' }); }, 0);
    };
    FakeWS.prototype.send = function () {};
    FakeWS.prototype.close = function () {};
    FakeWS.prototype.addEventListener = function (t, f) { if (t === 'error') setTimeout(() => f(new Event('error')), 0); if (t === 'close') setTimeout(() => f({ code: 1006 }), 0); };
    FakeWS.prototype.removeEventListener = function () {};
    FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
    window.WebSocket = FakeWS;
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') page.evaluate(t => window.__consoleErrors.push(t), m.text()).catch(() => {}); });
  page.on('pageerror', e => { fails.push('PAGEERROR: ' + e.message); FAIL++; });
  return { ctx, page, db };
}

async function jsErrors(page) {
  return page.evaluate(() => (window.__consoleErrors || []).filter(e => !/favicon|esm\.sh|net::|Failed to load resource|WebSocket|[Rr]ealtime|403|blocked/i.test(e)));
}

// グループを開いて支払いタブを表示する
async function openExpensesTab(page, BASE) {
  await page.goto(`${BASE}?g=${GID}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
  await page.click('.nb[data-tab="expenses"]');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('t-expenses')).display !== 'none');
}

// モーダルの#modal-msgに文字列が出るのを待ってOKを押す
async function acceptModal(page, includes) {
  await page.waitForFunction(t => {
    const bg = document.getElementById('modal-bg');
    return bg && getComputedStyle(bg).display !== 'none' && document.getElementById('modal-msg').textContent.includes(t);
  }, includes, { timeout: 10000 });
  await page.click('#modal-ok');
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const BASE = `http://localhost:${PORT}/ja/`;
  const browser = await chromium.launch();

  // ---------- A. 標準通貨データの整合性 ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => Array.isArray(window.CURR), { timeout: 15000 });
    const a = await page.evaluate(() => {
      const codes = window.CURR.map(c => c.code);
      return {
        count: codes.length,
        unique: new Set(codes).size === codes.length,
        fields: window.CURR.every(c => /^[A-Z]{3}$/.test(c.code) && c.name && c.en && c.country),
        common: window.COMMON_CURR,
        commonAllExist: window.COMMON_CURR.every(c => codes.includes(c)),
        codes,
      };
    });
    ok('[A] 標準通貨が150以上収録されている', a.count >= 150, String(a.count));
    ok('[A] 通貨コードが一意（重複なし）', a.unique);
    ok('[A] 全通貨がcode/日本語名/英語名/国名を持つ', a.fields);
    const required = ('JPY USD EUR GBP CHF CNY KRW TWD HKD MOP SGD THB VND MYR IDR PHP AUD NZD CAD ' +
      'INR NPR BTN LKR BDT PKR AED SAR QAR KWD BHD OMR ILS JOD TRY ' +
      'BRL ARS CLP COP PEN UYU PYG BOB MXN CRC GTQ HNL NIO PAB DOP JMD ' +
      'ZAR EGP MAD TND KES TZS UGX GHS NGN ETB RWF MUR SCR ' +
      'SEK NOK DKK ISK PLN CZK HUF RON BGN RSD ALL BAM MKD MDL UAH GEL AMD AZN ' +
      'KZT UZS KGS TJS TMT MNT FJD XPF PGK WST TOP VUV SBD').split(/\s+/);
    const missingReq = required.filter(c => !a.codes.includes(c));
    ok('[A] 必須通貨がすべて存在（' + required.length + '件）', missingReq.length === 0, missingReq.join(','));
    const existing22 = 'JPY THB KRW USD EUR GBP CNY HKD TWD SGD AUD CAD RSD HRK BAM MKD ALL BGN RON HUF MDL UAH'.split(' ');
    const missing22 = existing22.filter(c => !a.codes.includes(c));
    ok('[A] 既存22通貨がすべて維持されている', missing22.length === 0, missing22.join(','));
    ok('[A] 主要通貨の先頭12件が従来の並びのまま', a.common.slice(0, 12).join(',') === 'JPY,USD,EUR,GBP,CNY,HKD,KRW,TWD,SGD,THB,AUD,CAD', a.common.slice(0, 12).join(','));
    ok('[A] 主要通貨がすべて標準通貨に存在', a.commonAllExist);
    ok('[A] 旅行精算で使わないコードが除外されている', ['XAU', 'XAG', 'XPD', 'XPT', 'XXX', 'XTS', 'XDR', 'CLF', 'CHE', 'USN'].every(c => !a.codes.includes(c)));
    await ctx.close();
  }

  // ---------- B/C. 通貨検索と選択UI（実UI操作） ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, {
      recent: ['BRL', 'VND'],
      db: { members: MEMBERS.slice() },
    });
    await openExpensesTab(page, BASE);
    ok('[C] 既定の通貨表示が従来どおりJPY', (await page.textContent('#inp-ecur-label')).includes('JPY'), await page.textContent('#inp-ecur-label'));
    await page.click('#inp-ecur-btn');
    await page.waitForSelector('#cur-bg', { state: 'visible' });

    // セクション構成：最近使った通貨 → よく使われる通貨 → その他の通貨（折りたたみ）
    const secs = await page.evaluate(() => [...document.querySelectorAll('#cur-list .cur-sec')].map(x => x.textContent.trim()));
    ok('[C] セクション順序（最近→よく使われる→その他）', secs.join('|') === '最近使った通貨|よく使われる通貨|その他の通貨', secs.join('|'));
    const init = await page.evaluate(() => ({
      recentFirst: document.querySelector('#cur-list .cur-item') ? document.querySelector('#cur-list .cur-item').dataset.cur : null,
      shown: [...document.querySelectorAll('#cur-list .cur-item')].length,
      more: document.getElementById('cur-more') ? document.getElementById('cur-more').textContent : null,
    }));
    ok('[C] 最近使った通貨に追加通貨（BRL）が先頭表示される', init.recentFirst === 'BRL', String(init.recentFirst));
    ok('[C] 初期表示は最近＋主要のみで全通貨を展開しない', init.shown <= 30, String(init.shown));
    ok('[C] その他の通貨の展開ボタンがある（件数表示付き）', !!init.more && /その他の通貨をすべて表示（\d+通貨）/.test(init.more), String(init.more));

    // 展開すると全通貨が表示され、既存22通貨も選べる
    await page.click('#cur-more');
    const expanded = await page.evaluate(() => {
      const codes = [...document.querySelectorAll('#cur-list .cur-item')].map(b => b.dataset.cur);
      return { total: new Set(codes).size, has22: 'JPY THB KRW USD EUR GBP CNY HKD TWD SGD AUD CAD RSD HRK BAM MKD ALL BGN RON HUF MDL UAH'.split(' ').every(c => codes.includes(c)) };
    });
    ok('[C] 展開後に全標準通貨が表示される', expanded.total >= 150, String(expanded.total));
    ok('[C] 展開後の一覧に既存22通貨がすべて含まれる', expanded.has22);
    const noOverflow1 = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth <= window.innerWidth + 1, list: document.getElementById('cur-list').scrollWidth <= document.getElementById('cur-list').clientWidth + 1 }));
    ok('[C] 展開後も横はみ出しなし（390px）', noOverflow1.doc && noOverflow1.list, JSON.stringify(noOverflow1));
    await page.screenshot({ path: path.join(SHOT, 'currency-modal-expanded-390.png') });

    // 検索：BRLを7通りの表記で（結果は重複なく1件）
    const queries = ['BRL', 'brl', '　ＢＲＬ　', 'ブラジル', 'ブラジルレアル', 'Brazil', 'Brazilian real', 'Real', 'R$', 'ｒ＄'];
    for (const q of queries) {
      await page.fill('#cur-search', q);
      const r = await page.evaluate(() => [...document.querySelectorAll('#cur-list .cur-item')].map(b => b.dataset.cur));
      ok(`[B] 「${q}」でBRLが見つかる`, r.includes('BRL'), r.slice(0, 8).join(','));
      ok(`[B] 「${q}」の結果に重複がない`, new Set(r).size === r.length);
    }
    // 汎用語でも重複なし・複数ヒット
    await page.fill('#cur-search', 'ドル');
    const dollar = await page.evaluate(() => [...document.querySelectorAll('#cur-list .cur-item')].map(b => b.dataset.cur));
    ok('[B] 「ドル」で複数通貨がヒットする', dollar.length >= 5, String(dollar.length));
    ok('[B] 「ドル」の結果にも重複がない', new Set(dollar).size === dollar.length);
    // 国名検索（多国利用通貨）：フランス→EUR、タヒチ→XPF、セネガル→XOF
    for (const [q, code] of [['フランス', 'EUR'], ['ドイツ', 'EUR'], ['タヒチ', 'XPF'], ['セネガル', 'XOF'], ['ハワイ', 'USD'], ['米国', 'USD']]) {
      await page.fill('#cur-search', q);
      const r = await page.evaluate(() => [...document.querySelectorAll('#cur-list .cur-item')].map(b => b.dataset.cur));
      ok(`[B] 国・地域名「${q}」で${code}が見つかる`, r.includes(code), r.slice(0, 8).join(','));
    }
    await page.fill('#cur-search', 'ブラジル');
    await page.screenshot({ path: path.join(SHOT, 'currency-search-brl-390.png') });

    // 検索結果から追加通貨BRLを選択できる
    await page.click('#cur-list [data-cur="BRL"]');
    await page.waitForSelector('#cur-bg', { state: 'hidden' });
    const sel = await page.evaluate(() => ({ v: document.getElementById('inp-ecur').value, l: document.getElementById('inp-ecur-label').textContent }));
    ok('[C] 追加通貨BRLを選択できる（hidden値）', sel.v === 'BRL', sel.v);
    ok('[C] 選択後のラベルにBRLが表示される', sel.l.includes('BRL'), sel.l);

    // 既存通貨RSDも従来どおり選択できる
    await page.click('#inp-ecur-btn');
    await page.click('#cur-more');
    await page.click('#cur-list [data-cur="RSD"]');
    await page.waitForSelector('#cur-bg', { state: 'hidden' });
    ok('[C] 既存通貨RSDを従来どおり選択できる', await page.evaluate(() => document.getElementById('inp-ecur').value) === 'RSD');

    // 小数桁：VNDは小数不可（追加通貨の最小単位が効いている）
    await page.click('#inp-ecur-btn');
    await page.fill('#cur-search', 'VND');
    await page.click('#cur-list [data-cur="VND"]');
    await page.waitForSelector('#cur-bg', { state: 'hidden' });
    await page.fill('#inp-ename', 'フォー');
    await page.fill('#inp-eamt', '100.5');
    await page.click('#btn-add-expense');
    await acceptModal(page, '小数を使えません');
    ok('[D] VND（小数0桁）で小数入力が拒否される', true);

    // BRLは小数2桁OK：登録→最近使った通貨の先頭にBRLが保存される
    await page.click('#inp-ecur-btn');
    await page.fill('#cur-search', 'BRL');
    await page.click('#cur-list [data-cur="BRL"]');
    await page.waitForSelector('#cur-bg', { state: 'hidden' });
    await page.fill('#inp-eamt', '10.55');
    await page.click('#btn-add-expense');
    await page.waitForFunction(() => document.getElementById('exp-list').textContent.includes('BRL'), { timeout: 10000 });
    const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('narika_recent_curr') || '[]'));
    ok('[C] 支払い登録で追加通貨が最近使った通貨の先頭に保存される', rec[0] === 'BRL', rec.join(','));
    ok('[D] BRLの小数2桁の支払いが登録・表示される', await page.evaluate(() => document.getElementById('exp-list').textContent.includes('10.55')));
    // 再度モーダルを開くと最近使った通貨にBRLが表示される
    await page.click('#inp-ecur-btn');
    const rec2 = await page.evaluate(() => {
      const secs = [...document.querySelectorAll('#cur-list .cur-sec')];
      const recentSec = secs.find(s => s.textContent.includes('最近使った通貨'));
      return recentSec && recentSec.nextElementSibling ? recentSec.nextElementSibling.dataset.cur : null;
    });
    ok('[C] 再表示した最近使った通貨の先頭がBRL', rec2 === 'BRL', String(rec2));
    await page.keyboard.press('Escape');

    const errsBC = await jsErrors(page);
    ok('[B/C] 検索・選択フローでJSエラーなし', errsBC.length === 0, errsBC.join('||'));
    await ctx.close();
  }

  // ---------- D. 為替：追加通貨のレート入力→全期間再計算 ----------
  {
    const { ctx, page, db } = await newCtx(browser, { width: 390, height: 844 }, {
      db: {
        members: MEMBERS.slice(),
        expenses: [
          { id: 21, group_id: GID, name: '1月の夕食', date: '2026-01-01', amount: 100, currency: 'BRL', payer: 'まさと', beneficiaries: 'まさと,たろう,はなこ', split_mode: 'equal', split_details: null, created_at: '2026-01-01T00:00:00Z' },
          { id: 22, group_id: GID, name: '7月のホテル', date: '2026-07-01', amount: 200, currency: 'BRL', payer: 'たろう', beneficiaries: 'まさと,たろう,はなこ', split_mode: 'equal', split_details: null, created_at: '2026-07-01T00:00:00Z' },
        ],
      },
    });
    await page.goto(`${BASE}?g=${GID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById('exp-list').textContent.includes('BRL'), { timeout: 10000 });
    // レート未入力の間は換算待ちタグ
    ok('[D] レート未入力のBRL支払いは「為替レート入力待ち」', await page.evaluate(() => document.getElementById('exp-list').textContent.includes('為替レート入力待ち')));
    // 為替タブにBRL行が表示され、日本語名も出る
    await page.click('.nb[data-tab="rates"]');
    await page.waitForSelector('#rate-list [data-rc="BRL"]');
    ok('[D] 為替タブに追加通貨BRLの入力行が表示される', true);
    ok('[D] 為替タブにBRLの日本語名が表示される', await page.evaluate(() => document.getElementById('rate-list').textContent.includes('ブラジルレアル')));
    // 1 BRL = 30円 を入力（実UIのchangeイベント）
    await page.fill('#rate-list [data-rc="BRL"]', '30');
    await page.dispatchEvent('#rate-list [data-rc="BRL"]', 'change');
    // 保存→loadRates()→再描画（支払い一覧の円換算タグ更新）まで完了するのを待つ
    await page.waitForFunction(() => document.getElementById('exp-list').textContent.includes('3,000円'), { timeout: 10000 });
    const t30 = await page.evaluate(() => {
      const s = window.computeSettlements();
      window.renderSettle();
      return { total: Math.round(s.total), exp: document.getElementById('exp-list').textContent };
    });
    ok('[D] 1BRL=30円が全期間の支払いへ適用される（合計9,000円）', t30.total === 9000, String(t30.total));
    ok('[D] 1月の支払いも30円換算（≈3,000円）', t30.exp.includes('3,000円'), '');
    ok('[D] 7月の支払いも30円換算（≈6,000円）', t30.exp.includes('6,000円'), '');
    // レートを32円へ変更 → 過去分を含め再計算（再描画完了後に操作する）
    await page.fill('#rate-list [data-rc="BRL"]', '32');
    await page.dispatchEvent('#rate-list [data-rc="BRL"]', 'change');
    await page.waitForFunction(() => document.getElementById('exp-list').textContent.includes('3,200円'), { timeout: 10000 });
    const t32 = await page.evaluate(() => ({ total: Math.round(window.computeSettlements().total), exp: document.getElementById('exp-list').textContent }));
    ok('[D] レート変更（32円）で過去分を含め再計算される（合計9,600円）', t32.total === 9600, String(t32.total));
    ok('[D] 変更後は1月の支払いも32円換算（≈3,200円）', t32.exp.includes('3,200円'), '');
    ok('[D] 偽DB上のレートが上書き保存されている（upsert相当）', db.state.rates.filter(r => r.currency === 'BRL').length === 1 && String(db.state.rates.find(r => r.currency === 'BRL').rate) === '32', JSON.stringify(db.state.rates));
    await page.screenshot({ path: path.join(SHOT, 'rates-tab-brl-390.png') });

    // 未知の通貨コードでもクラッシュしない
    await page.evaluate(() => {
      window.__setSettleState(
        [{ name: 'まさと' }, { name: 'たろう' }],
        [{ id: 99, payer: 'まさと', amount: 500, currency: 'ZZZ', beneficiaries: 'まさと,たろう', split_mode: 'equal', split_details: null, date: '2026-07-01', name: '謎の支払い' }],
        {}, 1, 'zzz-group');
      window.renderSettle();
    });
    await page.click('.nb[data-tab="settle"]');
    const zzz = await page.evaluate(() => ({
      warn: getComputedStyle(document.getElementById('s-warn')).display !== 'none',
      result: document.getElementById('s-result').textContent,
    }));
    ok('[D] 未知コードZZZで精算画面がクラッシュせず警告表示', zzz.warn && zzz.result.includes('為替レート'), JSON.stringify(zzz));
    await page.click('.nb[data-tab="rates"]');
    ok('[D] 未知コードZZZの行が為替タブに表示される（フォールバック）', await page.evaluate(() => !!document.querySelector('#rate-list [data-rc="ZZZ"]')));
    const errsD = await jsErrors(page);
    ok('[D] 為替フローでJSエラーなし', errsD.length === 0, errsD.join('||'));
    ok('[D] 想定外のSupabase通信が発生していない', db.violations.length === 0, db.violations.join('||'));
    await ctx.close();
  }

  // ---------- E. JSONバックアップ復元（旧v1形式・v2形式） ----------
  {
    // v1（versionフィールドなし）：既存の古いバックアップ
    const { ctx, page, db } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.computeSettlements === 'function', { timeout: 15000 });
    const v1 = {
      app: 'narika', group_name: '旧形式グループ',
      members: [{ name: 'A' }, { name: 'B' }],
      expenses: [{ name: '夕食', date: '2025-01-01', amount: 1000, currency: 'THB', payer: 'A', beneficiaries: 'A,B' }],
      rates: { THB: 4.3 },
    };
    await page.setInputFiles('#restore-file', { name: 'old-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(v1), 'utf8') });
    await acceptModal(page, '復元します');
    await acceptModal(page, '復元しました');
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById('g-title').textContent === '旧形式グループ', { timeout: 10000 });
    ok('[E] 旧v1形式バックアップを復元できる', true);
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForFunction(() => document.getElementById('exp-list').textContent.includes('THB'), { timeout: 10000 });
    const v1r = await page.evaluate(() => document.getElementById('exp-list').textContent);
    ok('[E] 復元した支払いが表示される（THB）', v1r.includes('夕食') && v1r.includes('1,000'), v1r.slice(0, 80));
    ok('[E] 復元した為替レートが適用される（1THB=4.3円→≈4,300円）', v1r.includes('4,300円'), v1r.slice(0, 120));
    ok('[E] v1復元で想定外のSupabase通信なし', db.violations.length === 0, db.violations.join('||'));
    const errsE1 = await jsErrors(page);
    ok('[E] v1復元フローでJSエラーなし', errsE1.length === 0, errsE1.join('||'));
    await ctx.close();
  }
  {
    // v2（現行形式）＋追加通貨BRLのレート・傾斜配分を含む
    const { ctx, page, db } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.computeSettlements === 'function', { timeout: 15000 });
    const v2 = {
      app: 'narika', version: 2, exported_at: '2026-07-26T00:00:00Z', group_name: 'ブラジル旅行',
      members: [{ name: 'A' }, { name: 'B' }],
      expenses: [
        { name: 'シュラスコ', date: '2026-07-01', amount: 100, currency: 'BRL', payer: 'A', beneficiaries: 'A,B' },
        { name: 'タクシー', date: '2026-07-02', amount: 50, currency: 'BRL', payer: 'B', beneficiaries: 'A,B', split_mode: 'percentage', split_details: [{ member: 'A', share_permille: 600 }, { member: 'B', share_permille: 400 }] },
      ],
      rates: { BRL: 32 },
    };
    await page.setInputFiles('#restore-file', { name: 'new-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(v2), 'utf8') });
    await acceptModal(page, '復元します');
    await acceptModal(page, '復元しました');
    await page.waitForFunction(() => document.getElementById('g-title').textContent === 'ブラジル旅行', { timeout: 15000 });
    await page.waitForFunction(() => { const s = window.computeSettlements(); return s.ready && s.settles.length >= 0 && Math.round(s.total) === 4800; }, { timeout: 10000 });
    ok('[E] 追加通貨BRL入りのv2バックアップを復元できる（合計150BRL=4,800円）', true);
    const split = await page.evaluate(() => {
      const s = window.computeSettlements();
      return { total: Math.round(s.total), owedA: Math.round(s.owed['A']), owedB: Math.round(s.owed['B']) };
    });
    // 100BRL均等(A:50,B:50) + 50BRLを60:40(A:30,B:20) → A:80BRL=2,560円 B:70BRL=2,240円
    ok('[E] 復元後の傾斜配分がBRLレートで正しく計算される', split.owedA === 2560 && split.owedB === 2240, JSON.stringify(split));
    ok('[E] v2復元で想定外のSupabase通信なし', db.violations.length === 0, db.violations.join('||'));
    const errsE2 = await jsErrors(page);
    ok('[E] v2復元フローでJSエラーなし', errsE2.length === 0, errsE2.join('||'));
    await ctx.close();
  }

  // ---------- F. PC 1280x800 レイアウト ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 }, { db: { members: MEMBERS.slice() } });
    await openExpensesTab(page, BASE);
    await page.click('#inp-ecur-btn');
    await page.waitForSelector('#cur-bg', { state: 'visible' });
    await page.click('#cur-more');
    const pc = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth <= window.innerWidth + 1,
      list: document.getElementById('cur-list').scrollWidth <= document.getElementById('cur-list').clientWidth + 1,
      count: document.querySelectorAll('#cur-list .cur-item').length,
    }));
    ok('[F] PC 1280pxで展開後も横はみ出しなし', pc.doc && pc.list, JSON.stringify(pc));
    await page.screenshot({ path: path.join(SHOT, 'currency-modal-pc-1280.png') });
    await page.fill('#cur-search', 'ブラジル');
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(SHOT, 'currency-search-pc-1280.png') });
    const errsF = await jsErrors(page);
    ok('[F] PC表示フローでJSエラーなし', errsF.length === 0, errsF.join('||'));
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`\n==== E2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

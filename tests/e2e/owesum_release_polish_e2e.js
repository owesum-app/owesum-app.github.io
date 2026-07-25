// OweSum 公開前修正（2026-07-25）のE2E検証（Playwright・DBアクセスなし）。
// 検証範囲：
//  A. 精算画面：合計支出/1人あたりカードの削除、個人別の精算内訳の合計行、送金額表の維持、横スクロールなし
//  B. 共有URL：tab=settle & ogv=20260725-1 付与、共有URLで精算タブ初期表示、通常URLはメンバータブ維持
//  C. OGPメタタグ（ローカル配信HTML上の静的検証。外部URL疎通はテスト外でcurl確認）
// SupabaseへのRESTアクセスはPlaywrightのルート横取りでモックし、書き込み（GET以外）は遮断して検出する。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = 'C:\\Users\\narim\\narika';
const MIME = { '.html': 'text/html;charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };
const SHOT = process.env.SHOT_DIR || path.join(__dirname, 'shots');
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

let PASS = 0, FAIL = 0; const fails = [];
function ok(name, cond, extra) { if (cond) { PASS++; } else { FAIL++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); } }

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(ROOT, p);
  fs.readFile(fp, (e, data) => {
    if (e) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

// 23,000円ケース：まさとが23,000円立替、3人均等 → 負担7,667/7,667/7,666、立替合計=負担合計=23,000
const GID = 'e2e-share-group';
const GNAME = 'テスト旅行';
const MEMBERS = [
  { id: 1, group_id: GID, name: 'まさと', created_at: '2026-07-25T00:00:01Z' },
  { id: 2, group_id: GID, name: 'たろう', created_at: '2026-07-25T00:00:02Z' },
  { id: 3, group_id: GID, name: 'はなこ', created_at: '2026-07-25T00:00:03Z' },
];
const EXPENSES = [
  { id: 10, group_id: GID, payer: 'まさと', amount: 23000, currency: 'JPY', beneficiaries: 'まさと,たろう,はなこ', split_mode: 'equal', split_details: null, date: '2026-07-25', created_at: '2026-07-25T01:00:00Z', memo: '宿代' },
];

let dbWrites = [];
async function newCtx(browser, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport });
  // Supabase RESTをモック：GETのみ許可し、group/members/expenses/ratesへ固定データを返す。GET以外は遮断して記録
  await ctx.route('**/rest/v1/**', route => {
    const req = route.request();
    const url = req.url();
    if (req.method() !== 'GET') { dbWrites.push(req.method() + ' ' + url); return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"blocked by e2e"}' }); }
    const body = url.includes('/rest/v1/groups') ? (url.includes(encodeURIComponent(GID)) || url.includes(GID) ? [{ id: GID, name: GNAME }] : [])
      : url.includes('/rest/v1/members') ? MEMBERS
      : url.includes('/rest/v1/expenses') ? EXPENSES
      : url.includes('/rest/v1/rates') ? []
      : [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  if (opts.introSeen) {
    await ctx.addInitScript(gid => { localStorage.setItem('narika_intro_seen_gids', JSON.stringify([gid])); }, GID);
  }
  await ctx.addInitScript(() => {
    window.__consoleErrors = [];
    window.__shareCalls = [];
    Object.defineProperty(navigator, 'share', { configurable: true, writable: true, value: d => { window.__shareCalls.push(d); return Promise.resolve(); } });
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') page.evaluate(t => window.__consoleErrors.push(t), m.text()).catch(() => {}); });
  page.on('pageerror', e => { fails.push('PAGEERROR: ' + e.message); FAIL++; });
  return { ctx, page };
}

// ネットワーク由来のノイズ（realtime/websocket/リソース読込）を除いたJSエラー
async function jsErrors(page) {
  return page.evaluate(() => (window.__consoleErrors || []).filter(e => !/favicon|esm\.sh|net::|Failed to load resource|WebSocket|realtime/i.test(e)));
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const BASE = `http://localhost:${PORT}/index.html`;
  const browser = await chromium.launch();

  // ---------- B-1. 共有URL（tab=settle&ogv）で開くと精算タブが初期表示される（紹介画面確認済み端末） ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { introSeen: true });
    const shareUrl = `${BASE}?g=${GID}&tab=settle&ogv=20260725-1`;
    await page.goto(shareUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const on = document.querySelector('.nb.on');
      return on && on.dataset.tab === 'settle' && getComputedStyle(document.getElementById('t-settle')).display !== 'none';
    }, { timeout: 15000 }).catch(() => {});
    const st = await page.evaluate(() => ({
      onTab: (document.querySelector('.nb.on') || {}).dataset ? document.querySelector('.nb.on').dataset.tab : null,
      settleShown: getComputedStyle(document.getElementById('t-settle')).display !== 'none',
      membersHidden: getComputedStyle(document.getElementById('t-members')).display === 'none',
      title: document.getElementById('g-title').textContent,
    }));
    ok('[B] 共有URLで精算タブが選択される', st.onTab === 'settle', JSON.stringify(st));
    ok('[B] 共有URLで精算画面が表示・メンバー画面は非表示', st.settleShown && st.membersHidden, JSON.stringify(st));
    ok('[B] グループ名が読み込まれている', st.title === GNAME, st.title);

    // ---------- A. 精算画面の検証（実データ読込後の実画面） ----------
    const a = await page.evaluate(() => {
      const settle = document.getElementById('t-settle');
      const bal = document.getElementById('s-balance');
      const rows = [...bal.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()));
      const foot = [...bal.querySelectorAll('tfoot tr')].map(tr => [...tr.children].map(td => td.textContent.trim()));
      const footCs = bal.querySelector('tfoot td') ? getComputedStyle(bal.querySelector('tfoot td')) : null;
      const res = document.getElementById('s-result');
      return {
        settleText: settle.textContent,
        statTotal: !!document.getElementById('s-total'), statPer: !!document.getElementById('s-per'),
        heading: [...settle.querySelectorAll('.sec')].map(x => x.textContent.trim()),
        rows, foot,
        footWeight: footCs ? footCs.fontWeight : null, footBorderTop: footCs ? footCs.borderTopWidth : null,
        resText: res.textContent,
        rbs: [...settle.querySelectorAll('.rb')].map(b => b.dataset.r),
        roundNote: (document.getElementById('round-note') || {}).textContent || '',
        scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
        balScrollOk: bal.scrollWidth <= bal.clientWidth + 1,
      };
    });
    ok('[A] 「合計支出」が存在しない', !a.settleText.includes('合計支出') && !a.statTotal, a.statTotal ? 's-total残存' : '');
    ok('[A] 「1人あたり（一人当たり）」が存在しない', !a.settleText.includes('1人あたり') && !a.settleText.includes('一人当たり') && !a.statPer, '');
    ok('[A] 見出し「個人別の精算内訳」維持', a.heading.includes('個人別の精算内訳'), a.heading.join(','));
    ok('[A] 内訳は3名分の行', a.rows.length === 3, JSON.stringify(a.rows));
    ok('[A] 合計行が存在し左端が「合計」', a.foot.length === 1 && a.foot[0][0] === '合計', JSON.stringify(a.foot));
    const yen = s => parseInt(String(s).replace(/[^0-9-]/g, ''), 10);
    ok('[A] 立替合計が23,000円', a.foot.length === 1 && yen(a.foot[0][1]) === 23000, JSON.stringify(a.foot));
    ok('[A] 負担合計が23,000円', a.foot.length === 1 && yen(a.foot[0][2]) === 23000, JSON.stringify(a.foot));
    ok('[A] 合計行の差引列が空欄', a.foot.length === 1 && a.foot[0][3] === '', JSON.stringify(a.foot));
    ok('[A] 合計行が太字', a.footWeight && parseInt(a.footWeight, 10) >= 600, a.footWeight);
    ok('[A] 合計行に上罫線', a.footBorderTop && parseFloat(a.footBorderTop) > 0, a.footBorderTop);
    const rowPaidSum = a.rows.reduce((s, r) => s + yen(r[1]), 0);
    const rowOwedSum = a.rows.reduce((s, r) => s + yen(r[2]), 0);
    ok('[A] 各行の立替合計も23,000円', rowPaidSum === 23000, String(rowPaidSum));
    ok('[A] 各行の負担合計も23,000円', rowOwedSum === 23000, String(rowOwedSum));
    ok('[A] 送金額表が維持されている', a.resText.includes('→') && a.resText.includes('円'), a.resText.slice(0, 50));
    ok('[A] 送金単位ボタンが1/10/100円', a.rbs.join(',') === '1,10,100', a.rbs.join(','));
    ok('[A] 四捨五入の説明が維持されている', /単位で(表示|四捨五入)/.test(a.roundNote), a.roundNote);
    ok('[A] スマホ390pxで横スクロールなし', a.scrollW <= a.innerW + 1, `scroll=${a.scrollW} inner=${a.innerW}`);
    ok('[A] 内訳カード内も横はみ出しなし', a.balScrollOk, '');
    await page.screenshot({ path: path.join(SHOT, 'settle-390.png'), fullPage: true });

    // ---------- B-2. 共有文のURLと金額 ----------
    await page.click('#btn-share-settle');
    await page.click('#share-line');
    const sh = await page.evaluate(() => {
      const c = window.__shareCalls[window.__shareCalls.length - 1] || {};
      const disp = [...document.getElementById('s-result').textContent.matchAll(/([\d,]+)円/g)].map(x => parseInt(x[1].replace(/,/g, ''), 10));
      return { text: c.text || '', disp, url: window.buildSettleShareUrl ? window.buildSettleShareUrl('e2e-share-group') : null };
    });
    const m = sh.text.match(/https?:\/\/\S+/);
    const sharedUrl = m ? m[0] : '';
    let q = null; try { q = new URL(sharedUrl).searchParams; } catch (e) {}
    ok('[B] 共有文にURLが1つ含まれる', !!m && sh.text.split(sharedUrl).length - 1 === 1, sharedUrl);
    ok('[B] 共有URLに g=グループID を維持', !!q && q.get('g') === 'e2e-share-group', sharedUrl);
    ok('[B] 共有URLに tab=settle', !!q && q.get('tab') === 'settle', sharedUrl);
    ok('[B] 共有URLに ogv=20260725-1', !!q && q.get('ogv') === '20260725-1', sharedUrl);
    const shareAmts = [...sh.text.matchAll(/([\d,]+)円/g)].map(x => parseInt(x[1].replace(/,/g, ''), 10)).sort();
    ok('[B] 共有文の送金金額が画面と一致', JSON.stringify(shareAmts) === JSON.stringify(sh.disp.slice().sort()) && shareAmts.length > 0, `share=${shareAmts} disp=${sh.disp}`);
    const errs1 = await jsErrors(page);
    ok('[B] 共有フローでJSエラーなし', errs1.length === 0, errs1.join('||'));
    await ctx.close();
  }

  // ---------- B-3. 通常のグループURLは従来どおりメンバータブ ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { introSeen: true });
    await page.goto(`${BASE}?g=${GID}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForTimeout(600); // loadAll完了後もタブが切り替わらないことを確認するための猶予
    const st = await page.evaluate(() => ({
      onTab: document.querySelector('.nb.on') ? document.querySelector('.nb.on').dataset.tab : null,
      membersShown: getComputedStyle(document.getElementById('t-members')).display !== 'none',
    }));
    ok('[B] 通常URLは初期タブがメンバーのまま', st.onTab === 'members' && st.membersShown, JSON.stringify(st));
    await ctx.close();
  }

  // ---------- B-4. 新規ブラウザーコンテキスト（紹介画面未確認）でも共有URL→開くで精算タブ ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }); // introSeenなし＝完全新規
    await page.goto(`${BASE}?g=${GID}&tab=settle&ogv=20260725-1`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-intro').classList.contains('show'), { timeout: 15000 });
    ok('[B] 新規端末ではまず紹介画面が表示される（従来仕様維持）', true);
    await page.click('#btn-intro-open');
    await page.waitForFunction(() => {
      const on = document.querySelector('.nb.on');
      return on && on.dataset.tab === 'settle';
    }, { timeout: 15000 }).catch(() => {});
    const st = await page.evaluate(() => ({
      onTab: document.querySelector('.nb.on') ? document.querySelector('.nb.on').dataset.tab : null,
      settleShown: getComputedStyle(document.getElementById('t-settle')).display !== 'none',
    }));
    ok('[B] 新規端末でも「グループを開く」後に精算タブが選択される', st.onTab === 'settle' && st.settleShown, JSON.stringify(st));
    const errs = await jsErrors(page);
    ok('[B] 新規端末フローでJSエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- B-5. 存在しないグループの共有URLでもJSエラーを出さない ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { introSeen: true });
    await page.goto(`${BASE}?g=no-such-group&tab=settle&ogv=20260725-1`, { waitUntil: 'load' });
    // ask()モーダルが出る想定 → OKを押して閉じ、グループ一覧へ戻ることを確認
    await page.waitForTimeout(800);
    await page.evaluate(() => { const b = document.getElementById('modal-ok'); if (b && getComputedStyle(document.getElementById('modal-bg')).display !== 'none') b.click(); });
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({ groupList: document.getElementById('p-group').classList.contains('show') }));
    const errs = await jsErrors(page);
    ok('[B] 存在しないグループでJSエラーなし', errs.length === 0, errs.join('||'));
    ok('[B] 存在しないグループはグループ一覧へフォールバック', st.groupList, JSON.stringify(st));
    await ctx.close();
  }

  // ---------- A-2. PC 1280pxでの精算画面と横スクロール ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 }, { introSeen: true });
    await page.goto(`${BASE}?g=${GID}&tab=settle&ogv=20260725-1`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const on = document.querySelector('.nb.on');
      return on && on.dataset.tab === 'settle';
    }, { timeout: 15000 }).catch(() => {});
    const a = await page.evaluate(() => ({
      onTab: document.querySelector('.nb.on') ? document.querySelector('.nb.on').dataset.tab : null,
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
      foot: [...document.querySelectorAll('#s-balance tfoot td')].map(td => td.textContent.trim()),
    }));
    ok('[A] PCでも共有URLで精算タブ表示', a.onTab === 'settle', String(a.onTab));
    ok('[A] PC 1280pxで横スクロールなし', a.scrollW <= a.innerW + 1, `scroll=${a.scrollW} inner=${a.innerW}`);
    ok('[A] PCでも合計行が23,000円', a.foot.length === 4 && a.foot[0] === '合計' && a.foot[1].includes('23,000') && a.foot[2].includes('23,000'), JSON.stringify(a.foot));
    await page.screenshot({ path: path.join(SHOT, 'settle-pc-1280.png'), fullPage: true });
    await ctx.close();
  }

  // ---------- C. OGPメタタグ（配信HTML・クエリ付きURLでも同一） ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 800, height: 600 });
    for (const [label, u] of [['素URL', BASE], ['共有クエリ付き', `${BASE}?g=${GID}&tab=settle&ogv=20260725-1`]]) {
      await page.goto(u, { waitUntil: 'domcontentloaded' });
      const og = await page.evaluate(() => {
        const g = p => { const el = document.querySelector(`meta[property="${p}"]`) || document.querySelector(`meta[name="${p}"]`); return el ? el.getAttribute('content') : null; };
        return {
          title: g('og:title'), desc: g('og:description'), image: g('og:image'), secure: g('og:image:secure_url'),
          type: g('og:image:type'), w: g('og:image:width'), h: g('og:image:height'), url: g('og:url'),
          card: g('twitter:card'), timg: g('twitter:image'),
        };
      });
      ok(`[C] ${label}: og:imageがHTTPS絶対URL`, !!og.image && og.image.startsWith('https://'), String(og.image));
      ok(`[C] ${label}: og:image:secure_urlがog:imageと一致`, og.secure === og.image, String(og.secure));
      ok(`[C] ${label}: og:image:typeがimage/png`, og.type === 'image/png', String(og.type));
      ok(`[C] ${label}: 寸法メタが1731x909`, og.w === '1731' && og.h === '909', `${og.w}x${og.h}`);
      ok(`[C] ${label}: twitter:cardがsummary_large_image`, og.card === 'summary_large_image', String(og.card));
      ok(`[C] ${label}: twitter:imageがog:imageと同一`, og.timg === og.image, String(og.timg));
      ok(`[C] ${label}: og:title/og:description維持`, og.title === 'OweSum｜みんなの立替を、かんたん精算' && !!og.desc, String(og.title));
      ok(`[C] ${label}: og:urlが正式公開先`, og.url === 'https://narimatsumasato.github.io/narika/', String(og.url));
    }
    // ローカル配信での画像実体確認（実寸はメタと一致するか）
    const imgFile = path.join(ROOT, 'owesum-line-20260724.png');
    const buf = fs.readFileSync(imgFile);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    ok('[C] 実画像owesum-line-20260724.pngの実寸が1731x909', w === 1731 && h === 909, `${w}x${h}`);
    ok('[C] 実画像がPNGシグネチャ', buf.slice(1, 4).toString() === 'PNG', '');
    await ctx.close();
  }

  ok('[DB] Supabaseへの書き込み（GET以外）が発生していない', dbWrites.length === 0, dbWrites.join('||'));

  await browser.close();
  server.close();
  console.log(`\n==== E2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

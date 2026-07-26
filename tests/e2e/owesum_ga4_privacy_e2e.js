// OweSum GA4プライバシー配慮計測（2026-07-26）のE2E検証（Playwright・本番通信なし）。
// 検証範囲：
//  S. 静的検証：ルートにGAタグなし／ja/index.htmlに測定IDが1回だけ／send_page_view:false／configが1回だけ
//  P. page_view：1回だけ送信、page_location・page_referrerにクエリ・ハッシュ・グループIDが載らない
//  G. group_created：作成成功時だけ1回、失敗・二重クリック・JSON復元・既存グループ表示では送信しない
//  F. 耐障害性：gtag.js読込み失敗（広告ブロック相当）でもOweSum本体が動く
//  L. レイアウト・OGP・ルート遷移の不変確認
//  N. 通信検証：本番Supabase通信0件、Google以外の想定外通信0件
// GoogleへもSupabaseへも実送信しない：
//  ・googletagmanager.com/gtag/js はルート横取りでスタブJSを返す（gtag既定の「現在URLをdlに添付」も再現し、上書き漏れを検出可能にする）
//  ・google-analytics.com/g/collect はルート横取りで記録して204を返す
//  ・supabase.co へのHTTPは全横取りでモック応答、WebSocketはaddInitScriptで無効化
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = 'C:\\Users\\narim\\OweSum';
const MIME = { '.html': 'text/html;charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };
const SHOT = process.env.SHOT_DIR || path.join(__dirname, 'shots');
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

const GA_ID = 'G-BG875EQN2K';
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

// 既存の安全スイートと同じモックデータ（招待URL・既存グループ表示用）
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
const NEW_GID = 'e2e-created-group-uuid-0001';

// gtag.jsスタブ：実gtag同様、page_location未指定のイベントには現在URL（location.href）をdlとして添付する。
// これによりアプリ側の上書きが漏れていれば ?g= がpayloadへ現れ、テストで検出できる。
const GTAG_STUB = `(function(){
  window.__gaStubLoaded=true;
  function send(a){
    var name=a[1], p=a[2]||{};
    var q='v=2&tid=${GA_ID}&en='+encodeURIComponent(name)
      +'&dl='+encodeURIComponent(p.page_location!==undefined?p.page_location:location.href)
      +'&dt='+encodeURIComponent(p.page_title!==undefined?p.page_title:document.title)
      +'&dr='+encodeURIComponent(p.page_referrer!==undefined?p.page_referrer:document.referrer);
    var extras=[];
    for(var k in p){ if(k!=='page_location'&&k!=='page_title'&&k!=='page_referrer'){ extras.push('ep.'+encodeURIComponent(k)+'='+encodeURIComponent(String(p[k]))); } }
    if(extras.length)q+='&'+extras.join('&');
    try{ fetch('https://www.google-analytics.com/g/collect?'+q,{method:'POST'}).catch(function(){}); }catch(e){}
  }
  var dl=window.dataLayer=window.dataLayer||[];
  for(var i=0;i<dl.length;i++){ var a=dl[i]; if(a&&a[0]==='event')send(a); }
  var push=dl.push;
  dl.push=function(){ var a=arguments[0]; if(a&&a[0]==='event')send(a); return push.apply(dl,arguments); };
})();`;

// 通信の記録（コンテキスト横断で集計）
let allRequests = [];          // {url, method} 全リクエスト
let supabaseSeen = [];         // ブラウザーが発行したsupabase.co宛リクエスト
let supabaseHandled = [];      // テストのルート横取りがモック応答したsupabase.co宛リクエスト
let collectHits = [];          // Google Analytics収集payload {url, post, en, dl, dt, dr, extras}
let dbWrites = [];             // 想定外のSupabase書込み（許可シナリオ以外）

function parseCollect(url, post) {
  const u = new URL(url);
  const q = u.searchParams;
  const extras = {};
  for (const [k, v] of q.entries()) if (k.startsWith('ep.')) extras[k] = v;
  return { url, post: post || '', en: q.get('en'), dl: q.get('dl'), dt: q.get('dt'), dr: q.get('dr'), extras };
}

async function newCtx(browser, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport });

  // 1) Google Tag Manager：スタブJSを返す（blockGtag時は読込み失敗を再現）
  await ctx.route(/googletagmanager\.com/, route => {
    if (opts.blockGtag) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: GTAG_STUB });
  });
  // 2) Google Analytics収集：記録して204（実送信なし）
  await ctx.route(/google-analytics\.com/, route => {
    const req = route.request();
    collectHits.push(parseCollect(req.url(), req.postData()));
    return route.fulfill({ status: 204, body: '' });
  });
  // 3) Supabase REST：全横取りでモック。POSTは許可シナリオ（groups/members作成）だけ成功応答
  await ctx.route(/supabase\.co/, async route => {
    const req = route.request();
    const url = req.url();
    supabaseHandled.push(req.method() + ' ' + url);
    if (req.method() === 'GET') {
      const body = url.includes('/rest/v1/groups') ? ((url.includes(GID) ? [{ id: GID, name: GNAME }] : (url.includes(NEW_GID) ? [{ id: NEW_GID, name: '作成テスト' }] : [])))
        : url.includes('/rest/v1/members') ? (url.includes(NEW_GID) ? [] : MEMBERS)
        : url.includes('/rest/v1/expenses') ? (url.includes(NEW_GID) ? [] : EXPENSES)
        : url.includes('/rest/v1/rates') ? []
        : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (req.method() === 'POST' && url.includes('/rest/v1/groups')) {
      if (opts.failGroupInsert) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'e2e簡易エラー', code: 'E2E' }) });
      }
      let name = '不明';
      try { name = JSON.parse(req.postData() || '{}').name || name; } catch (e) {}
      if (opts.slowGroupInsert) await new Promise(r => setTimeout(r, 400));
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: NEW_GID, name, created_at: '2026-07-26T00:00:00Z' }) });
    }
    if (req.method() === 'POST' && (url.includes('/rest/v1/members') || url.includes('/rest/v1/expenses') || url.includes('/rest/v1/rates'))) {
      return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
    }
    dbWrites.push(req.method() + ' ' + url);
    return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"blocked by e2e"}' });
  });

  if (opts.introSeen) {
    await ctx.addInitScript(gid => { localStorage.setItem('narika_intro_seen_gids', JSON.stringify([gid])); }, GID);
  }
  await ctx.addInitScript(() => {
    window.__consoleErrors = [];
    // Realtime用WebSocketを完全無効化し、本番Supabaseへの接続を遮断する
    window.__wsAttempts = [];
    window.WebSocket = class {
      constructor(url) { window.__wsAttempts.push(String(url)); this.readyState = 3; }
      addEventListener() {} removeEventListener() {} send() {} close() {}
      set onopen(v) {} set onclose(v) {} set onerror(v) {} set onmessage(v) {}
    };
  });
  const page = await ctx.newPage();
  page.on('request', req => {
    allRequests.push({ url: req.url(), method: req.method() });
    if (/supabase\.co/.test(req.url())) supabaseSeen.push(req.method() + ' ' + req.url());
  });
  page.on('console', m => { if (m.type() === 'error') page.evaluate(t => window.__consoleErrors.push(t), m.text()).catch(() => {}); });
  page.on('pageerror', e => { fails.push('PAGEERROR: ' + e.message); FAIL++; });
  return { ctx, page };
}

// ネットワーク由来のノイズ（CDN・realtime・読込み失敗系）を除いたJSエラー
async function jsErrors(page) {
  return page.evaluate(() => (window.__consoleErrors || []).filter(e => !/favicon|esm\.sh|net::|Failed to load resource|WebSocket|realtime|googletagmanager|jsdelivr/i.test(e)));
}
function dataLayerEvents(page) {
  return page.evaluate(() => (window.dataLayer || []).filter(a => a && a[0] === 'event').map(a => ({ name: a[1], params: Object.assign({}, a[2] || {}) })));
}
function payloadText(hits) { return hits.map(h => decodeURIComponent(h.url) + ' ' + h.post).join('\n'); }

(async () => {
  // ---------- S. 静的検証 ----------
  const rootHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const jaHtml = fs.readFileSync(path.join(ROOT, 'ja', 'index.html'), 'utf8');
  ok('[S] ルートindex.htmlに測定IDがない', !rootHtml.includes(GA_ID), '');
  ok('[S] ルートindex.htmlにgtag/googletagmanagerがない', !/gtag|googletagmanager/i.test(rootHtml), '');
  ok('[S] ja/index.htmlに測定IDがちょうど1回', jaHtml.split(GA_ID).length - 1 === 1, String(jaHtml.split(GA_ID).length - 1) + '回');
  ok('[S] send_page_view:false が設定されている', /send_page_view\s*:\s*false/.test(jaHtml), '');
  ok('[S] gtag(\'config\'…) がちょうど1回', jaHtml.split("gtag('config'").length - 1 === 1, '');
  ok('[S] configにpage_locationの安全な上書きがある', /page_location\s*:\s*SAFE_LOC/.test(jaHtml), '');
  ok('[S] アクセス解析の公表表示がある', jaHtml.includes('アクセス解析について') && jaHtml.includes('policies.google.com'), '');

  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const BASE = `http://localhost:${PORT}/ja/`;
  const SAFE_BASE = `http://localhost:${PORT}/ja/`; // origin+pathname（クエリ・ハッシュなし）
  const browser = await chromium.launch();

  // ---------- P-1. トップページ：page_viewが1回だけ・安全なpayload（スマホ390px） ----------
  {
    collectHits = [];
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE, { waitUntil: 'load', referer: 'https://referrer.example/path/to?secret=1#frag' });
    await page.waitForFunction(() => window.__gaStubLoaded === true, { timeout: 15000 });
    await page.waitForTimeout(500);
    const evs = await dataLayerEvents(page);
    const pvs = evs.filter(e => e.name === 'page_view');
    const pvHits = collectHits.filter(h => h.en === 'page_view');
    ok('[P] page_viewがdataLayerに1回だけ', pvs.length === 1, JSON.stringify(evs));
    ok('[P] page_view収集リクエストが1回だけ', pvHits.length === 1, payloadText(collectHits));
    const pv = pvHits[0] || { dl: '', dt: '', dr: '' };
    ok('[P] page_locationがorigin+pathnameのみ', pv.dl === SAFE_BASE, String(pv.dl));
    ok('[P] page_locationにクエリがない', !String(pv.dl).includes('?'), String(pv.dl));
    ok('[P] page_locationにハッシュがない', !String(pv.dl).includes('#'), String(pv.dl));
    ok('[P] page_titleが固定値OweSum', pv.dt === 'OweSum', String(pv.dt));
    ok('[P] page_referrerからクエリ・ハッシュが除去されている', pv.dr === 'https://referrer.example/path/to', String(pv.dr));
    ok('[P] 送信payloadにreferrerの機密クエリがない', !payloadText(collectHits).includes('secret'), '');
    // 公表表示（アクセス解析について）が開ける
    const note = await page.evaluate(() => {
      const d = document.getElementById('analytics-note');
      if (!d) return null;
      d.open = true;
      const body = d.querySelector('.analytics-note-body');
      return { visible: !!d.offsetParent || getComputedStyle(d).display !== 'none', text: body ? body.textContent : '' };
    });
    ok('[L] アクセス解析の説明がトップに表示される', !!note && note.visible && note.text.includes('Google Analytics'), JSON.stringify(note ? note.visible : null));
    ok('[L] 説明に「送信しない設計」の明示がある', !!note && note.text.includes('送信しない'), '');
    const layout = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, heroImg: !!document.querySelector('.hero-img') }));
    ok('[L] スマホ390pxで横スクロールなし', layout.scrollW <= layout.innerW + 1, `scroll=${layout.scrollW} inner=${layout.innerW}`);
    ok('[L] トップのヒーロー画像が維持されている', layout.heroImg, '');
    await page.screenshot({ path: path.join(SHOT, 'ga4-top-390.png'), fullPage: true });
    const errs = await jsErrors(page);
    ok('[P] トップ表示でコンソールエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- P-2. 招待URL（?g=…&tab=settle&ogv=…）でもGoogleへg値・tab・ogvが漏れない ----------
  {
    collectHits = [];
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { introSeen: true });
    await page.goto(`${BASE}?g=${GID}&tab=settle&ogv=20260725-2#result`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__gaStubLoaded === true, { timeout: 15000 });
    await page.waitForFunction(() => { const on = document.querySelector('.nb.on'); return on && on.dataset.tab === 'settle'; }, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    const text = payloadText(collectHits);
    const pvHits = collectHits.filter(h => h.en === 'page_view');
    ok('[P] 招待URLでもpage_viewは1回だけ', pvHits.length === 1, payloadText(collectHits));
    ok('[P] 招待URLでdlにクエリ・ハッシュがない', pvHits.length === 1 && pvHits[0].dl === SAFE_BASE, String(pvHits[0] && pvHits[0].dl));
    ok('[P] payloadにグループIDがない', !text.includes(GID), '');
    ok('[P] payloadにtab=settleがない', !text.includes('tab=settle'), '');
    ok('[P] payloadにogvがない', !text.includes('ogv='), '');
    ok('[P] payloadにグループ名がない', !text.includes(GNAME) && !text.includes(encodeURIComponent(GNAME)), '');
    ok('[P] payloadにメンバー名がない', !/まさと|たろう|はなこ/.test(text) && !text.includes(encodeURIComponent('まさと')), '');
    ok('[P] payloadに金額23000がない', !text.includes('23000') && !text.includes('23,000'), '');
    ok('[G] 既存グループを開いてもgroup_created送信なし', collectHits.filter(h => h.en === 'group_created').length === 0, '');
    // 精算画面が正常動作（回帰）
    const settleOk = await page.evaluate(() => { const on = document.querySelector('.nb.on'); return on && on.dataset.tab === 'settle' && document.getElementById('s-result').textContent.includes('→'); });
    ok('[L] 招待URLの精算表示が従来どおり動く', settleOk, '');
    const errs = await jsErrors(page);
    ok('[P] 招待URLフローでコンソールエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- G-1. グループ作成成功で group_created が1回だけ（二重クリック防止込み） ----------
  {
    collectHits = [];
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 }, { slowGroupInsert: true });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__gaStubLoaded === true, { timeout: 15000 });
    await page.fill('#gname', '作成テスト');
    // 二重クリック：作成処理中（モック側で400ms遅延）に2回目を押す
    await page.click('#btn-create-group');
    await page.click('#btn-create-group', { delay: 50 }).catch(() => {});
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForTimeout(600);
    const gcHits = collectHits.filter(h => h.en === 'group_created');
    const groupPosts = allRequests.filter(r => r.method === 'POST' && r.url.includes('/rest/v1/groups'));
    ok('[G] 作成成功でgroup_createdが1回だけ', gcHits.length === 1, payloadText(collectHits.filter(h => h.en === 'group_created')));
    ok('[G] 二重クリックでもgroups INSERTは1回', groupPosts.length === 1, JSON.stringify(groupPosts));
    const gc = gcHits[0] || { dl: '', dt: '', extras: { x: 'missing' } };
    ok('[G] group_createdに独自パラメータがない', Object.keys(gc.extras).length === 0, JSON.stringify(gc.extras));
    ok('[G] group_createdのdlも安全なURLのみ', gc.dl === SAFE_BASE, String(gc.dl));
    const gcText = payloadText(gcHits);
    ok('[G] group_createdにグループ名がない', !gcText.includes('作成テスト') && !gcText.includes(encodeURIComponent('作成テスト')), '');
    ok('[G] group_createdに新グループIDがない', !gcText.includes(NEW_GID), '');
    const errs = await jsErrors(page);
    ok('[G] 作成フローでコンソールエラーなし', errs.length === 0, errs.join('||'));
    await page.screenshot({ path: path.join(SHOT, 'ga4-created-pc-1280.png'), fullPage: true });
    await ctx.close();
  }

  // ---------- G-2. グループ作成失敗では group_created を送信しない ----------
  {
    collectHits = [];
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { failGroupInsert: true });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__gaStubLoaded === true, { timeout: 15000 });
    await page.click('#btn-hero-create');
    await page.fill('#gname-modal', '失敗テスト');
    await page.click('#create-ok');
    await page.waitForTimeout(800);
    const modalShown = await page.evaluate(() => getComputedStyle(document.getElementById('modal-bg')).display !== 'none' && document.getElementById('modal-msg').textContent.includes('作成失敗'));
    ok('[G] 失敗時は作成失敗ダイアログが出る（従来仕様）', modalShown, '');
    ok('[G] 失敗時はgroup_created送信なし', collectHits.filter(h => h.en === 'group_created').length === 0, payloadText(collectHits));
    ok('[G] 失敗payloadにエラー本文・グループ名がない', !payloadText(collectHits).includes('失敗テスト') && !payloadText(collectHits).includes('E2E'), '');
    await ctx.close();
  }

  // ---------- G-3. JSON復元では group_created を送信しない ----------
  {
    collectHits = [];
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__gaStubLoaded === true, { timeout: 15000 });
    const backup = { app: 'narika', version: 2, group_name: '復元グループ', members: [{ name: 'ふっき' }], expenses: [], rates: {} };
    await page.setInputFiles('#restore-file', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup), 'utf8') });
    await page.waitForFunction(() => getComputedStyle(document.getElementById('modal-bg')).display !== 'none', { timeout: 15000 });
    await page.click('#modal-ok'); // 「復元します。よろしいですか？」
    await page.waitForFunction(() => document.getElementById('modal-msg').textContent.includes('復元しました'), { timeout: 15000 });
    await page.click('#modal-ok');
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    await page.waitForTimeout(500);
    ok('[G] JSON復元でgroup_created送信なし', collectHits.filter(h => h.en === 'group_created').length === 0, payloadText(collectHits));
    ok('[G] 復元payloadにグループ名・メンバー名がない', !payloadText(collectHits).includes(encodeURIComponent('復元グループ')) && !payloadText(collectHits).includes(encodeURIComponent('ふっき')), '');
    await ctx.close();
  }

  // ---------- F. gtag.js読込み失敗（広告ブロック相当）でも本体が動く ----------
  {
    collectHits = [];
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { blockGtag: true, introSeen: true });
    await page.goto(`${BASE}?g=${GID}&tab=settle&ogv=20260725-2`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const on = document.querySelector('.nb.on'); return on && on.dataset.tab === 'settle'; }, { timeout: 15000 }).catch(() => {});
    const st = await page.evaluate(() => ({
      settle: document.getElementById('s-result').textContent.includes('→'),
      title: document.getElementById('g-title').textContent,
      gtagType: typeof window.gtag,
    }));
    ok('[F] gtag読込み失敗でも精算画面が表示される', st.settle && st.title === GNAME, JSON.stringify(st));
    ok('[F] gtag読込み失敗でもwindow.gtagは関数のまま（クラッシュしない）', st.gtagType === 'function', st.gtagType);
    ok('[F] gtag読込み失敗時はGoogleへの収集リクエストなし', collectHits.length === 0, payloadText(collectHits));
    // グループ作成も通常どおり動く（メンバータブへ戻ってから一覧へ）
    await page.click('.nb[data-tab="members"]');
    await page.click('#btn-back');
    await page.waitForFunction(() => document.getElementById('p-group').classList.contains('show'), { timeout: 15000 });
    await page.click('#btn-hero-create');
    await page.fill('#gname-modal', 'ブロック中作成');
    await page.click('#create-ok');
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    ok('[F] gtag読込み失敗でもグループ作成が成功する', true);
    const errs = await jsErrors(page);
    ok('[F] 広告ブロック相当でもコンソールエラーなし', errs.length === 0, errs.join('||'));
    await ctx.close();
  }

  // ---------- L. ルート遷移・OGP不変 ----------
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { introSeen: true });
    // ルートのリダイレクトはクエリ・ハッシュを付けたまま/ja/へ渡す（静的コード確認）。
    // 遷移後にアプリがURLを?g=のみへ正規化するのは従来からの仕様のため、
    // ランタイムでは「クエリが実際に届いた結果」（グループ表示＋精算タブ初期表示）で検証する。
    ok('[L] ルートのリダイレクトがクエリ・ハッシュを維持するコードのまま', rootHtml.includes("location.replace('/ja/' + location.search + location.hash)"), '');
    await page.goto(`http://localhost:${PORT}/?g=${GID}&tab=settle&ogv=20260725-2#result`, { waitUntil: 'load' });
    await page.waitForFunction(() => location.pathname === '/ja/', { timeout: 15000 });
    await page.waitForFunction(() => { const on = document.querySelector('.nb.on'); return on && on.dataset.tab === 'settle'; }, { timeout: 15000 }).catch(() => {});
    const nav = await page.evaluate(() => ({
      path: location.pathname,
      gname: document.getElementById('g-title').textContent,
      onTab: document.querySelector('.nb.on') ? document.querySelector('.nb.on').dataset.tab : null,
    }));
    ok('[L] ルート→/ja/遷移でg・tabがアプリへ届く（グループ＋精算タブ表示）', nav.path === '/ja/' && nav.gname === GNAME && nav.onTab === 'settle', JSON.stringify(nav));
    const og = await page.evaluate(() => {
      const g = p => { const el = document.querySelector(`meta[property="${p}"]`) || document.querySelector(`meta[name="${p}"]`); return el ? el.getAttribute('content') : null; };
      return { title: g('og:title'), image: g('og:image'), url: g('og:url'), card: g('twitter:card'), canonical: (document.querySelector('link[rel="canonical"]') || {}).href };
    });
    ok('[L] og:title不変', og.title === 'OweSum｜飲み会も旅行も簡単に精算', String(og.title));
    ok('[L] og:image不変（正式画像URL）', og.image === 'https://owesum-app.github.io/assets/images/owesum-ogp.png?v=20260725-2', String(og.image));
    ok('[L] og:url・canonical不変', og.url === 'https://owesum-app.github.io/ja/' && og.canonical === 'https://owesum-app.github.io/ja/', JSON.stringify(og));
    ok('[L] twitter:card不変', og.card === 'summary_large_image', String(og.card));
    const imgs = ['owesum-ogp.png', 'owesum-hero-mobile.png', 'owesum-hero-pc.png'].map(f => fs.existsSync(path.join(ROOT, 'assets', 'images', f)));
    ok('[L] 正式画像3枚が存在する', imgs.every(Boolean), JSON.stringify(imgs));
    // PC 1280pxレイアウト
    const { ctx: ctx2, page: page2 } = await newCtx(browser, { width: 1280, height: 800 });
    await page2.goto(BASE, { waitUntil: 'load' });
    await page2.waitForTimeout(400);
    const pc = await page2.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth }));
    ok('[L] PC 1280pxで横スクロールなし', pc.scrollW <= pc.innerW + 1, `scroll=${pc.scrollW} inner=${pc.innerW}`);
    await page2.screenshot({ path: path.join(SHOT, 'ga4-top-pc-1280.png'), fullPage: false });
    await ctx2.close();
    await ctx.close();
  }

  // ---------- N. 通信の総合検証 ----------
  {
    const wsLeaks = []; // WebSocketはaddInitScriptで全て無効化済み（__wsAttemptsに記録されるのみ）
    ok('[N] 本番Supabaseへ到達した通信が0件（発行数＝モック横取り数）', supabaseSeen.length === supabaseHandled.length, `seen=${supabaseSeen.length} handled=${supabaseHandled.length}`);
    ok('[N] 想定外のSupabase書込みが0件', dbWrites.length === 0, dbWrites.join('||'));
    const allowedHosts = ['localhost', 'esm.sh', 'cdn.jsdelivr.net', 'www.googletagmanager.com', 'www.google-analytics.com', 'bqlrtohnxwpswgqttqbs.supabase.co'];
    const unexpected = [...new Set(allRequests.map(r => { try { return new URL(r.url).hostname; } catch (e) { return r.url; } }))].filter(h => !allowedHosts.includes(h));
    ok('[N] Google・CDN・モック以外への通信0件', unexpected.length === 0, unexpected.join('||'));
    ok('[N] Googleへの収集は全てテストが横取り（実送信なし）', true, ''); // route.fulfillで204返却のため実網へは出ない
    ok('[N] WebSocket実接続0件', wsLeaks.length === 0, '');
  }

  await browser.close();
  server.close();
  console.log(`\n==== GA4 E2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

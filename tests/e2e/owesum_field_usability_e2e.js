// OweSum 実機修正のE2E検証（Playwright）。narikaディレクトリをローカル配信しindex.htmlを検証する。
// 旧セッションのe2e_narika.js/e2e_split.jsはscratchpad揮発で消失。ここでは依頼の27項目＋スモークを網羅する新スイート。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = 'C:\\Users\\narim\\OweSum';
const MIME = { '.html':'text/html;charset=utf-8', '.webp':'image/webp', '.png':'image/png', '.json':'application/json', '.js':'text/javascript', '.css':'text/css' };
const SHOT = path.join(__dirname, 'shots');
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT);

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

const INIT = () => {
  window.__consoleErrors = [];
  window.__shareCalls = [];
  window.__copyCalls = [];
  window.__mailtos = [];
  window.__shareReject = false;
  Object.defineProperty(navigator, 'share', {
    configurable: true, writable: true,
    value: function (d) {
      window.__shareCalls.push(d);
      if (window.__shareReject) { const e = new Error('cancel'); e.name = 'AbortError'; return Promise.reject(e); }
      return Promise.resolve();
    }
  });
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => { window.__copyCalls.push(t); return Promise.resolve(); } }
    });
  } catch (e) {}
  // location.href='mailto:...' を傍受する。Chromiumでは Location.prototype.href が再定義不可なことがあるため
  // インスタンス→プロトタイプの順で試し、どちらも不可なら __mailtoErr を立てて純関数検証にフォールバックする。
  let installed = false;
  try {
    const d = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    Object.defineProperty(window.location, 'href', {
      configurable: true,
      get() { return d.get.call(window.location); },
      set(v) { if (typeof v === 'string' && v.indexOf('mailto:') === 0) { window.__mailtos.push(v); return; } return d.set.call(window.location, v); }
    });
    installed = true;
  } catch (e) { /* try prototype next */ }
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

// 精算テスト用データ：A=10000円建替え、A/B/C均等 → A +6666 / B -3333 / C -3333（1円の位が発生）
const SETTLE_DATA = {
  members: [{ name: 'まさと' }, { name: 'みつこ' }, { name: 'たくや' }],
  expenses: [{ payer: 'まさと', amount: 10000, currency: 'JPY', beneficiaries: 'まさと,みつこ,たくや', split_mode: 'equal', split_details: null }],
  rates: {}
};

function parseYen(text) { const m = [...text.matchAll(/([\d,]+)円/g)].map(x => parseInt(x[1].replace(/,/g, ''), 10)); return m; }

(async () => {
  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const BASE = `http://localhost:${PORT}/index.html`;
  const browser = await chromium.launch();

  async function open(viewport) {
    const ctx = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') page.evaluate(t => window.__consoleErrors.push(t), m.text()).catch(() => {}); });
    page.on('pageerror', e => { fails.push('PAGEERROR: ' + e.message); FAIL++; });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.computeSettlements === 'function', { timeout: 15000 });
    return { ctx, page };
  }

  // ---------- HERO 画像（スマホ4サイズ） ----------
  const SIZES = [{ w: 375, h: 667 }, { w: 375, h: 720 }, { w: 390, h: 844 }, { w: 430, h: 932 }];
  for (const s of SIZES) {
    const { ctx, page } = await open({ width: s.w, height: s.h });
    // 画像読み込み完了を待つ
    await page.waitForFunction(() => { const i = document.querySelector('.hero-img'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 10000 });
    const m = await page.evaluate(() => {
      const img = document.querySelector('.hero-img');
      const r = img.getBoundingClientRect();
      const btn = document.getElementById('btn-hero-create');
      const br = btn.getBoundingClientRect();
      return { vw: window.innerWidth, imgL: r.left, imgR: r.right, imgW: r.width, imgTop: r.top, imgBottom: r.bottom, btnTop: br.top, btnW: br.width, imgDisp: getComputedStyle(img).display, objFit: getComputedStyle(img).objectFit };
    });
    const tag = `${s.w}x${s.h}`;
    ok(`[hero ${tag}] 画像幅が画面幅の95%以上`, m.imgW / m.vw >= 0.95, `ratio=${(m.imgW / m.vw).toFixed(3)}`);
    ok(`[hero ${tag}] 左右に大きな余白がない`, m.imgL <= 3 && m.imgR >= m.vw - 3, `L=${m.imgL} R=${m.imgR} vw=${m.vw}`);
    ok(`[hero ${tag}] 画像が表示されている`, m.imgDisp !== 'none' && m.imgBottom > m.imgTop);
    ok(`[hero ${tag}] 新しいグループを作るボタンが画像直下（大空白なし）`, m.btnTop >= m.imgBottom - 2 && (m.btnTop - m.imgBottom) < 40, `gap=${(m.btnTop - m.imgBottom).toFixed(1)}`);
    await page.screenshot({ path: path.join(SHOT, `hero-${tag}.png`), fullPage: false });
    await ctx.close();
  }

  // ---------- 下部タブ ----------
  {
    const { ctx, page } = await open({ width: 390, height: 844 });
    // グループページに遷移させナビを表示（実UIに近い状態）
    await page.evaluate(() => {
      document.getElementById('p-intro').classList.remove('show');
      document.getElementById('p-group').classList.remove('show');
      document.getElementById('p-main').classList.add('show');
      document.getElementById('main-nav').style.display = 'flex';
    });
    const nav = await page.evaluate(() => {
      const nbs = [...document.querySelectorAll('.nb')];
      const navEl = document.querySelector('.nav');
      const cs = getComputedStyle(navEl);
      const off = nbs.find(b => !b.classList.contains('on'));
      const on = document.querySelector('.nb.on');
      const offc = getComputedStyle(off);
      const onc = getComputedStyle(on);
      return {
        count: nbs.length,
        labels: nbs.map(b => b.textContent.trim()),
        navBg: cs.backgroundColor, navShadow: cs.boxShadow, navBorder: cs.borderTopWidth,
        offColor: offc.color, offOpacity: offc.opacity, offIconSize: getComputedStyle(off.querySelector('i')).fontSize,
        onBg: onc.backgroundColor, onColor: onc.color, onFontW: onc.fontWeight,
        heights: nbs.map(b => b.getBoundingClientRect().height),
        navBottom: navEl.getBoundingClientRect().bottom, vh: window.innerHeight
      };
    });
    const rgb = s => (s.match(/\d+/g) || []).map(Number);
    const offC = rgb(nav.offColor);
    const onB = rgb(nav.onBg);
    ok('[tab] 4タブ存在', nav.count === 4);
    ok('[tab] ラベルがメンバー/支払い/為替/精算', nav.labels.join(',') === 'メンバー,支払い,為替,精算', nav.labels.join(','));
    ok('[tab] 背景が不透明な白', nav.navBg === 'rgb(255, 255, 255)', nav.navBg);
    ok('[tab] 上に境界線または影がある', (parseFloat(nav.navBorder) > 0) || (nav.navShadow && nav.navShadow !== 'none'), `border=${nav.navBorder} shadow=${nav.navShadow}`);
    ok('[tab] 未選択タブの文字色が十分濃い', offC[0] < 130 && offC[1] < 130 && offC[2] < 140, nav.offColor);
    ok('[tab] 未選択タブのopacityが下がりすぎない', parseFloat(nav.offOpacity) >= 0.9, nav.offOpacity);
    ok('[tab] アイコンが大きい(>=24px)', parseFloat(nav.offIconSize) >= 24, nav.offIconSize);
    ok('[tab] 選択中タブが背景色を持つ', onB.length === 3 && !(onB[0] === 255 && onB[1] === 255 && onB[2] === 255) && !(nav.onBg.indexOf('rgba') === 0 && onB[3] === 0), nav.onBg);
    ok('[tab] 選択中タブの文字が白', nav.onColor === 'rgb(255, 255, 255)', nav.onColor);
    ok('[tab] タップ領域が各タブ56px以上', nav.heights.every(h => h >= 56), JSON.stringify(nav.heights.map(x => Math.round(x))));
    ok('[tab] ナビが画面下端に固定', Math.abs(nav.navBottom - nav.vh) < 2, `bottom=${nav.navBottom} vh=${nav.vh}`);
    // タブ切替：精算タブを押すとt-settleが表示されon付与
    await page.click('.nb[data-tab="settle"]');
    const sw = await page.evaluate(() => ({
      settleShown: getComputedStyle(document.getElementById('t-settle')).display !== 'none',
      membersHidden: getComputedStyle(document.getElementById('t-members')).display === 'none',
      onIsSettle: document.querySelector('.nb.on').dataset.tab === 'settle'
    }));
    ok('[tab] 押すと正しい画面に切替（精算表示）', sw.settleShown && sw.membersHidden && sw.onIsSettle, JSON.stringify(sw));
    await page.screenshot({ path: path.join(SHOT, 'tabs-390.png') });
    await ctx.close();
  }

  // 精算タブを実際に表示状態にする（.rb / #btn-share-settle / #s-result は t-settle 内）
  const showSettle = async (page) => page.evaluate(() => {
    document.getElementById('p-intro').classList.remove('show');
    document.getElementById('p-group').classList.remove('show');
    document.getElementById('p-main').classList.add('show');
    document.getElementById('main-nav').style.display = 'flex';
    document.querySelectorAll('.tab').forEach(t => t.style.display = 'none');
    document.getElementById('t-settle').style.display = 'block';
    document.querySelectorAll('.nb').forEach(b => b.classList.remove('on'));
    document.querySelector('.nb[data-tab="settle"]').classList.add('on');
  });

  // ---------- 精算単位 ----------
  {
    const { ctx, page } = await open({ width: 390, height: 844 });
    await showSettle(page);
    await page.evaluate((d) => { window.__setSettleState(d.members, d.expenses, d.rates, 1, 'test-group-id'); document.getElementById('g-title').textContent = 'テスト旅行'; window.renderSettle(); }, SETTLE_DATA);
    // 1円単位の結果
    const one = await page.evaluate(() => {
      const s = window.computeSettlements().settles;
      const disp = parseYen(document.getElementById('s-result').textContent);
      const share = window.buildSettleShareText('テスト旅行', s, window.buildInviteUrl('test-group-id'));
      return { amts: s.map(x => x.amt), disp, shareAmts: parseYen(share) };
      function parseYen(t) { return [...t.matchAll(/([\d,]+)円/g)].map(x => parseInt(x[1].replace(/,/g, ''), 10)); }
    });
    ok('[unit] 1円単位に1円の位が存在', one.amts.some(a => a % 10 !== 0), JSON.stringify(one.amts));
    ok('[unit] 1円: 画面表示と共有文の金額が一致', JSON.stringify(one.disp.sort()) === JSON.stringify(one.shareAmts.sort()) && one.disp.length > 0, `disp=${one.disp} share=${one.shareAmts}`);
    // 10円単位へ変更（実UIのボタンをクリック）
    await page.click('.rb[data-r="10"]');
    const ten = await page.evaluate(() => {
      const s = window.computeSettlements().settles;
      const disp = [...document.getElementById('s-result').textContent.matchAll(/([\d,]+)円/g)].map(x => parseInt(x[1].replace(/,/g, ''), 10));
      const share = window.buildSettleShareText('テスト旅行', s, window.buildInviteUrl('test-group-id'));
      const shareAmts = [...share.matchAll(/([\d,]+)円/g)].map(x => parseInt(x[1].replace(/,/g, ''), 10));
      return { unit: window.__getRoundUnit(), amts: s.map(x => x.amt), disp, shareAmts };
    });
    ok('[unit] 変更でroundUnitが10になる', ten.unit === 10, String(ten.unit));
    ok('[unit] 10円単位の全送金額が10で割り切れる', ten.amts.length > 0 && ten.amts.every(a => a % 10 === 0), JSON.stringify(ten.amts));
    ok('[unit] 1円単位と10円単位の結果が異なる', JSON.stringify(one.amts.sort()) !== JSON.stringify(ten.amts.slice().sort()), `1=${one.amts} 10=${ten.amts}`);
    ok('[unit] 単位変更直後に画面表示が更新される', JSON.stringify(one.disp.slice().sort()) !== JSON.stringify(ten.disp.slice().sort()), `1=${one.disp} 10=${ten.disp}`);
    ok('[unit] 単位変更直後に共有文も更新される', JSON.stringify(one.shareAmts.slice().sort()) !== JSON.stringify(ten.shareAmts.slice().sort()), `1=${one.shareAmts} 10=${ten.shareAmts}`);
    ok('[unit] 10円: 画面表示と共有文の金額が一致', JSON.stringify(ten.disp.slice().sort()) === JSON.stringify(ten.shareAmts.slice().sort()) && ten.disp.length > 0, `disp=${ten.disp} share=${ten.shareAmts}`);
    // 貸借が破綻しない（送金の純額で債権者=債務者、合計が単位で割り切れる）
    const bal = await page.evaluate(() => {
      const s = window.computeSettlements().settles; const net = {};
      s.forEach(x => { net[x.from] = (net[x.from] || 0) - x.amt; net[x.to] = (net[x.to] || 0) + x.amt; });
      const pos = Object.values(net).filter(v => v > 0).reduce((a, b) => a + b, 0);
      const neg = Object.values(net).filter(v => v < 0).reduce((a, b) => a + b, 0);
      return { pos, neg, allDiv: s.every(x => x.amt % 10 === 0) };
    });
    ok('[unit] 貸借の合計が破綻しない（債権=債務・単位整合）', bal.pos === -bal.neg && bal.allDiv, JSON.stringify(bal));
    await ctx.close();
  }

  // ---------- 共有 ----------
  {
    const { ctx, page } = await open({ width: 390, height: 844 });
    await showSettle(page);
    const GNAME = 'ゴパ🍺（打ち上げ・A&B）';
    await page.evaluate((d) => { window.__setSettleState(d.data.members, d.data.expenses, d.data.rates, 1, 'gid-xyz'); document.getElementById('g-title').textContent = d.gname; window.renderSettle(); }, { data: SETTLE_DATA, gname: GNAME });

    // 16 ボタン文言
    const btnText = await page.textContent('#btn-share-settle');
    ok('[share] ボタン文言が「精算結果をLINE・メールで共有」', btnText.trim() === '精算結果をLINE・メールで共有', btnText.trim());
    // 17 押すと選択肢が表示
    await page.click('#btn-share-settle');
    const sheet = await page.evaluate(() => ({
      shown: getComputedStyle(document.getElementById('share-bg')).display !== 'none',
      opts: [...document.querySelectorAll('#share-bg .share-opt')].map(b => b.textContent.trim())
    }));
    ok('[share] 押すと共有方法の選択肢が表示される', sheet.shown, String(sheet.shown));
    ok('[share] 選択肢がLINE/メール/コピー/キャンセル', sheet.opts.join('|') === 'LINEなどで共有|メールで送る|結果をコピー|キャンセル', sheet.opts.join('|'));
    await page.screenshot({ path: path.join(SHOT, 'share-sheet-390.png') });

    // 18/19 LINEなどで共有 → navigator.share（title,text のみ・URL1回）
    await page.click('#share-line');
    const sh = await page.evaluate(() => {
      const c = window.__shareCalls[window.__shareCalls.length - 1] || {};
      const urlCount = (c.text || '').split(window.buildInviteUrl('gid-xyz')).length - 1;
      return { called: window.__shareCalls.length, keys: Object.keys(c), hasUrl: 'url' in c, urlCount, text: c.text || '', title: c.title || '' };
    });
    ok('[share] LINE共有でnavigator.shareが呼ばれる', sh.called >= 1, String(sh.called));
    ok('[share] shareにurl項目を渡さない', sh.hasUrl === false, sh.keys.join(','));
    ok('[share] 本文中のURLはちょうど1つ', sh.urlCount === 1, 'count=' + sh.urlCount);
    ok('[share] shareのtitleが件名', sh.title === `OweSum「${GNAME}」の精算結果`, sh.title);

    // 20-24 メール mailto
    const mailto = await page.evaluate((gn) => {
      const url = window.buildInviteUrl('gid-xyz');
      const text = window.buildSettleShareText(gn, window.computeSettlements().settles, url);
      const m = window.buildSettleMailto(gn, text);
      const qs = m.replace(/^mailto:\?/, '');
      const params = new URLSearchParams(qs);
      return { m, subject: params.get('subject'), body: params.get('body'), url };
    }, GNAME);
    ok('[share] buildSettleMailtoがmailto:で始まる', mailto.m.indexOf('mailto:?subject=') === 0, mailto.m.slice(0, 30));
    ok('[share] mailto subjectが空欄でない', !!mailto.subject && mailto.subject.length > 0, mailto.subject || '(empty)');
    ok('[share] mailto件名が OweSum「グループ名」の精算結果', mailto.subject === `OweSum「${GNAME}」の精算結果`, mailto.subject);
    ok('[share] mailto本文に精算結果(送金)が入る', /→/.test(mailto.body) && /円/.test(mailto.body), mailto.body.slice(0, 40));
    ok('[share] mailto本文にURLが入る', mailto.body.indexOf(mailto.url) >= 0, String(mailto.body.indexOf(mailto.url)));
    ok('[share] 絵文字・記号入りグループ名で文字化けしない', mailto.subject.indexOf(GNAME) >= 0 && mailto.body.indexOf(GNAME) >= 0, mailto.subject);

    // 実ボタン経由のmailto（location.href傍受が効く環境なら）
    await page.evaluate(() => { document.getElementById('share-bg').style.display = 'flex'; });
    await page.click('#share-mail');
    const mail2 = await page.evaluate(() => ({ mailtos: window.__mailtos.slice(), err: window.__mailtoErr }));
    if (!mail2.err) {
      ok('[share] メールで送るボタンがmailtoを開く', mail2.mailtos.length >= 1 && mail2.mailtos[0].indexOf('mailto:?subject=') === 0, JSON.stringify(mail2.mailtos).slice(0, 60));
    } else {
      console.log('  (info) location.href傍受不可のためメールボタンの発火はbuildSettleMailtoの純関数検証で担保:', mail2.err);
    }

    // 25 結果をコピー
    await page.evaluate(() => { document.getElementById('share-bg').style.display = 'flex'; window.__copyCalls = []; });
    await page.click('#share-copy');
    await page.waitForTimeout(50);
    const cp = await page.evaluate((gn) => {
      // 精算共有はtab=settle&ogv付きのbuildSettleShareUrl()を使う仕様（2026-07-25変更）
      const url = window.buildSettleShareUrl('gid-xyz');
      const expected = window.buildSettleShareText(gn, window.computeSettlements().settles, url);
      const last = window.__copyCalls[window.__copyCalls.length - 1];
      const toast = document.querySelector('#toast-wrap .toast') ? document.querySelector('#toast-wrap .toast').textContent : '';
      return { copied: last, expected, toast };
    }, GNAME);
    ok('[share] 結果をコピーで同じ共有文がコピーされる', cp.copied === cp.expected, cp.copied ? 'copied len=' + cp.copied.length : '(none)');
    ok('[share] コピー成功トースト「精算結果をコピーしました」', cp.toast.indexOf('精算結果をコピーしました') >= 0, cp.toast);

    // 26 共有キャンセル(AbortError)でエラーが出ない
    await page.evaluate(() => { window.__shareReject = true; document.getElementById('share-bg').style.display = 'flex'; });
    let threw = false;
    try { await page.click('#share-line'); await page.waitForTimeout(80); } catch (e) { threw = true; }
    const afterCancel = await page.evaluate(() => {
      const toast = [...document.querySelectorAll('#toast-wrap .toast')].map(t => t.textContent).join('|');
      return { errToast: /error|コピーできません/.test(toast), errs: window.__consoleErrors.slice() };
    });
    ok('[share] 共有キャンセル(AbortError)でエラーが出ない', !threw && !afterCancel.errToast, JSON.stringify(afterCancel));

    // 27 JSエラーなし
    const errs = await page.evaluate(() => window.__consoleErrors.filter(e => !/favicon|esm\.sh|net::|Failed to load resource/i.test(e)));
    ok('[share] JavaScriptエラーがない', errs.length === 0, errs.join(' || '));
    await ctx.close();
  }

  // ---------- スモーク（非対応環境でコピーフォールバック） ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(() => {
      window.__copyCalls = [];
      try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: t => { window.__copyCalls.push(t); return Promise.resolve(); } } }); } catch (e) {}
      // navigator.share を非対応に
      try { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); } catch (e) {}
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.computeSettlements === 'function', { timeout: 15000 });
    await page.evaluate((d) => { window.__setSettleState(d.members, d.expenses, d.rates, 1, 'gid2'); document.getElementById('g-title').textContent = 'スモーク'; window.renderSettle(); }, SETTLE_DATA);
    await showSettle(page);
    await page.click('#btn-share-settle');
    await page.click('#share-line');
    await page.waitForTimeout(50);
    const r = await page.evaluate(() => ({ copied: window.__copyCalls.length >= 1, toast: (document.querySelector('#toast-wrap .toast') || {}).textContent || '' }));
    ok('[smoke] share非対応環境でLINE共有→クリップボードにコピー', r.copied && r.toast.indexOf('精算結果をコピーしました') >= 0, JSON.stringify(r));
    await ctx.close();
  }

  // ---------- PC 1280x800 スクショ ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.computeSettlements === 'function', { timeout: 15000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOT, 'top-pc-1280.png') });
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`\n==== E2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

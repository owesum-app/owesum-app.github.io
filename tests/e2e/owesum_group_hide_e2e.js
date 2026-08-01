// OweSum 参加中グループの「非表示・再表示」E2E（Playwright・本番通信なし）。
//
// 目的：日本語版(/ja/)・英語版(/en/)のトップにある参加中グループ一覧で、
// PCは「︙」メニュー、スマホは行の左スワイプから、グループを一覧上だけ非表示にできること、
// 「元に戻す」/Undo・「非表示にしたグループ」/Hidden groups からの再表示、ページ再読込後の永続化、
// 日英で非表示状態が分離されること、参加中グループID(narika_gids)が消えないこと、
// 非表示中でも直接URLでグループを開けること、非表示・再表示でSupabaseへ一切通信しない（削除通信0件）こと、
// 390pxで横スクロールが出ないこと、既存の漫画表示に回帰がないことを検証する。
//
// 本番Supabase・Googleへの通信はすべてルート横取りで遮断する（owesum_en_manga_e2e.jsと同方式）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = 'C:\\Users\\narim\\OweSum';
const MIME = { '.html': 'text/html;charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

let PASS = 0, FAIL = 0; const fails = [];
function ok(name, cond, extra) { if (cond) { PASS++; } else { FAIL++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); } }

const NETG = { gaObserved: 0, gaCaptured: 0, supaObserved: 0, supaHandledTotal: 0, otherExternal: [] };
const GA_HOST_RE = /(\.|^)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|google\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com|gstatic\.com)$/;
const SUPA_HOST_RE = /(\.|^)supabase\.co$/;
const KNOWN_HOST_RE = /^(localhost|127\.0\.0\.1|esm\.sh|cdn\.jsdelivr\.net)$/;

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

// テスト用グループ（Supabaseへは一切到達させず、ルート横取りで返す）
const GROUPS = [
  { id: 7001, name: 'グループA', base_currency: 'JPY', created_at: '2026-07-01T10:00:00Z' },
  { id: 7002, name: 'グループB', base_currency: 'JPY', created_at: '2026-07-02T10:00:00Z' },
  { id: 7003, name: 'グループC', base_currency: 'JPY', created_at: '2026-07-03T10:00:00Z' },
];

// Supabase宛は全件横取り。DELETE/PATCH/POSTが1件でも来たら記録して落とす
function makeCtxState() {
  return { rest: [], writes: [], deletes: [] };
}

async function newCtx(browser, viewport, state, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport }, opts || {}));
  await ctx.route(u => GA_HOST_RE.test(u.hostname), route => {
    NETG.gaCaptured++;
    const url = route.request().url();
    if (url.includes('/gtag/js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* e2e guard */' });
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.route(u => SUPA_HOST_RE.test(u.hostname), route => {
    NETG.supaHandledTotal++;
    const req = route.request();
    const method = req.method();
    state.rest.push(method + ' ' + req.url());
    if (method === 'DELETE') state.deletes.push(req.url());
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') state.writes.push(method + ' ' + req.url());
    const url = new URL(req.url());
    if (method === 'GET' && url.pathname.endsWith('/groups')) {
      // PostgRESTのeq.／in.フィルタを再現する（?g=によるID指定で正しい1件だけを返すため）
      let rows = GROUPS.slice();
      for (const [k, v] of url.searchParams) {
        let m = /^eq\.(.*)$/.exec(v);
        if (m) { rows = rows.filter(r => String(r[k]) === m[1]); continue; }
        m = /^in\.\((.*)\)$/.exec(v);
        if (m) {
          const set = m[1].split(',').map(s => s.replace(/^"|"$/g, ''));
          rows = rows.filter(r => set.indexOf(String(r[k])) >= 0);
        }
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }
    if (method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
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
    localStorage.setItem('narika_gids', JSON.stringify([7001, 7002, 7003]));
    window.__consoleErrors = [];
  });
  ctx.on('request', req => {
    let h; try { const u = new URL(req.url()); if (u.protocol !== 'http:' && u.protocol !== 'https:') return; h = u.hostname; } catch (e) { return; }
    if (GA_HOST_RE.test(h)) NETG.gaObserved++;
    else if (SUPA_HOST_RE.test(h)) NETG.supaObserved++;
    else if (!KNOWN_HOST_RE.test(h)) NETG.otherExternal.push(req.method() + ' ' + req.url());
  });
  const page = await ctx.newPage();
  const notFound = [];
  page.on('response', r => { if (r.status() === 404) notFound.push(r.url()); });
  page.on('console', m => { if (m.type() === 'error') page.evaluate(t => window.__consoleErrors.push(t), m.text()).catch(() => {}); });
  page.on('pageerror', e => { fails.push('PAGEERROR: ' + e.message); FAIL++; });
  return { ctx, page, notFound };
}

async function jsErrors(page) {
  return page.evaluate(() => (window.__consoleErrors || []).filter(e => !/favicon|esm\.sh|net::|Failed to load resource|WebSocket|realtime|googletagmanager|jsdelivr/i.test(e)));
}

const L = {
  ja: {
    base: '/ja/', key: 'owesum_hidden_gids_ja', otherKey: 'owesum_hidden_gids_en',
    hideBtn: '非表示', menuItem: '一覧から非表示', toast: '非表示にしました', undo: '元に戻す',
    section: '非表示にしたグループ', restore: '再表示', notice: 'このグループは参加中の一覧で非表示になっています',
    foreign: /Hide from this list|Hidden groups|Show again|Undo/,
  },
  en: {
    base: '/en/', key: 'owesum_hidden_gids_en', otherKey: 'owesum_hidden_gids_ja',
    hideBtn: 'Hide', menuItem: 'Hide from this list', toast: 'Hidden from your list', undo: 'Undo',
    section: 'Hidden groups', restore: 'Show again', notice: 'This group is hidden from Your groups',
    foreign: /一覧から非表示|非表示にしたグループ|再表示|元に戻す/,
  },
};

async function waitRows(page) {
  await page.waitForSelector('#my-groups .g-row', { timeout: 20000 });
}
async function rowIds(page) {
  return page.evaluate(() => [...document.querySelectorAll('#my-groups .g-row')].map(r => r.dataset.id));
}
async function hiddenIds(page) {
  return page.evaluate(() => [...document.querySelectorAll('#my-groups .hg-item')].map(r => r.dataset.id));
}
async function stored(page, key) {
  return page.evaluate(k => localStorage.getItem(k), key);
}
// 対象の行を画面内へ送ってから座標を取る（トップ画面は縦に長く、初期表示では一覧が画面外にある）
async function rowBox(page, id) {
  await page.evaluate(i => {
    const el = document.querySelector('#my-groups .g-row[data-id="' + i + '"]');
    if (el) el.scrollIntoView({ block: 'center' });
  }, id);
  await page.waitForTimeout(200);
  return page.evaluate(i => {
    const r = document.querySelector('#my-groups .g-row[data-id="' + i + '"] .g-item').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, id);
}
// 行の上を指でなぞる操作を再現する（deltaXが負なら左スワイプ）。
// 戻り値は指を離す直前に行へ適用されていたtransform（スワイプが起動したかの判定に使う）。
// releaseOutside=true のときは行の外で指を離す。スワイプ不成立の検証で、
// タップ扱いになってグループ画面へ遷移してしまうのを避けるため。
async function dragRow(page, id, deltaX, deltaY, releaseOutside) {
  const b = await rowBox(page, id);
  const cy = b.y + b.h / 2, sx = b.x + b.w - 20;
  await page.mouse.move(sx, cy);
  await page.mouse.down();
  const steps = 10;
  for (let i = 1; i <= steps; i++) await page.mouse.move(sx + (deltaX * i) / steps, cy + ((deltaY || 0) * i) / steps);
  const transform = await page.evaluate(i => {
    const it = document.querySelector('#my-groups .g-row[data-id="' + i + '"] .g-item');
    return it ? (it.style.transform || '') : '';
  }, id);
  if (releaseOutside) await page.mouse.move(5, 5);
  await page.mouse.up();
  await page.waitForTimeout(400);
  return transform;
}
// 「非表示にしたグループ」は折りたたみ（details）。中の操作前に開く
async function openHiddenSection(page) {
  await page.waitForSelector('#hidden-groups', { timeout: 15000 });
  const isOpen = await page.evaluate(() => document.getElementById('hidden-groups').open);
  if (!isOpen) await page.click('#hidden-groups .hg-summary');
  await page.waitForTimeout(150);
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const PORT = server.address().port;
  const browser = await chromium.launch();

  // ---------- A/B. PC(1280px)：「︙」メニューでの非表示・Undo・再表示・永続化（日英両方） ----------
  for (const lang of ['ja', 'en']) {
    const t = L[lang];
    const T = `[PC-${lang}]`;
    const state = makeCtxState();
    const { ctx, page, notFound } = await newCtx(browser, { width: 1280, height: 1000 }, state);
    await page.goto(`http://localhost:${PORT}${t.base}`, { waitUntil: 'load' });
    await waitRows(page);

    ok(`${T} 参加中グループが3件表示される`, (await rowIds(page)).length === 3, JSON.stringify(await rowIds(page)));
    ok(`${T} 非表示グループが0件のとき領域自体が出ない`, (await page.evaluate(() => !document.getElementById('hidden-groups'))) === true);
    ok(`${T} 各行に「︙」ボタンがある`, (await page.evaluate(() => document.querySelectorAll('#my-groups .g-kebab').length)) === 3);
    ok(`${T} 「︙」にaria-labelとaria-haspopupがある`, (await page.evaluate(() => {
      const k = document.querySelector('#my-groups .g-kebab');
      return !!(k.getAttribute('aria-label') && k.getAttribute('aria-haspopup') === 'menu' && k.getAttribute('aria-expanded') === 'false');
    })) === true);

    // 「︙」だけでは非表示にしない
    await page.click('#my-groups .g-row[data-id="7002"] .g-kebab');
    ok(`${T} 「︙」でメニューが開く`, (await page.evaluate(() => !!document.querySelector('.g-menu[role="menu"]'))) === true);
    ok(`${T} メニュー文言が「${t.menuItem}」`, (await page.evaluate(() => document.querySelector('.g-menu-item').textContent.trim())) === t.menuItem);
    ok(`${T} aria-expandedがtrueになる`, (await page.evaluate(() => document.querySelector('#my-groups .g-row[data-id="7002"] .g-kebab').getAttribute('aria-expanded'))) === 'true');
    ok(`${T} 「︙」だけでは非表示にならない`, (await rowIds(page)).length === 3, JSON.stringify(await rowIds(page)));

    // Escapeで閉じる
    await page.keyboard.press('Escape');
    ok(`${T} Escapeでメニューが閉じる`, (await page.evaluate(() => !document.querySelector('.g-menu'))) === true);
    ok(`${T} Escape後にaria-expandedがfalseへ戻る`, (await page.evaluate(() => document.querySelector('#my-groups .g-row[data-id="7002"] .g-kebab').getAttribute('aria-expanded'))) === 'false');

    // 一覧外クリックで閉じる
    await page.click('#my-groups .g-row[data-id="7002"] .g-kebab');
    await page.mouse.click(5, 5);
    ok(`${T} 一覧外クリックでメニューが閉じる`, (await page.evaluate(() => !document.querySelector('.g-menu'))) === true);

    // 複数同時に開かない
    await page.click('#my-groups .g-row[data-id="7001"] .g-kebab');
    await page.click('#my-groups .g-row[data-id="7003"] .g-kebab');
    ok(`${T} メニューは同時に1つしか開かない`, (await page.evaluate(() => document.querySelectorAll('.g-menu').length)) === 1);
    await page.keyboard.press('Escape');

    // キーボード操作（ArrowDownで開いてEnterで実行）
    await page.focus('#my-groups .g-row[data-id="7002"] .g-kebab');
    await page.keyboard.press('ArrowDown');
    ok(`${T} キーボード（ArrowDown）でメニューを開ける`, (await page.evaluate(() => !!document.querySelector('.g-menu'))) === true);
    ok(`${T} メニュー項目へフォーカスが移る`, (await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('g-menu-item'))) === true);

    const restBefore = state.rest.length;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const restAfterHide = state.rest.length;

    ok(`${T} メニュー項目の実行で一覧から消える`, JSON.stringify(await rowIds(page)) === JSON.stringify(['7001', '7003']), JSON.stringify(await rowIds(page)));
    ok(`${T} 非表示にしてもSupabaseへ通信しない`, restAfterHide - restBefore === 0, `calls=${restAfterHide - restBefore}`);
    ok(`${T} 非表示にしてもDELETE通信は0件`, state.deletes.length === 0, JSON.stringify(state.deletes));
    ok(`${T} 参加中グループID(narika_gids)は消えない`, (await stored(page, 'narika_gids')) === JSON.stringify([7001, 7002, 7003]), String(await stored(page, 'narika_gids')));
    ok(`${T} 非表示IDが専用キー(${t.key})へ保存される`, (await stored(page, t.key)) === '["7002"]', String(await stored(page, t.key)));
    ok(`${T} もう一方の言語キーには書かれない（日英分離）`, (await stored(page, t.otherKey)) === null, String(await stored(page, t.otherKey)));

    // 通知（Undo）
    ok(`${T} 「${t.toast}」通知が出る`, (await page.evaluate(() => { const e = document.querySelector('.toast-undo'); return e ? e.textContent : ''; })).includes(t.toast));
    ok(`${T} 通知に「${t.undo}」がある`, (await page.evaluate(() => { const b = document.querySelector('.toast-undo-btn'); return b ? b.textContent.trim() : ''; })) === t.undo);

    // 非表示一覧
    ok(`${T} 「${t.section}」の領域が出る`, (await page.evaluate(() => !!document.getElementById('hidden-groups'))) === true);
    const summary = await page.evaluate(() => document.querySelector('.hg-summary').textContent.trim());
    ok(`${T} 件数表示が1件`, /[（(]\s*1\s*[）)]/.test(summary), summary);
    ok(`${T} 非表示一覧に該当グループが並ぶ`, JSON.stringify(await hiddenIds(page)) === JSON.stringify(['7002']), JSON.stringify(await hiddenIds(page)));

    // Undoで戻る
    await page.click('.toast-undo-btn');
    await page.waitForTimeout(300);
    ok(`${T} Undoで一覧へ戻る`, JSON.stringify(await rowIds(page)) === JSON.stringify(['7001', '7002', '7003']), JSON.stringify(await rowIds(page)));
    ok(`${T} Undo後は保存も空になる`, (await stored(page, t.key)) === '[]', String(await stored(page, t.key)));
    ok(`${T} Undo後は非表示領域が消える`, (await page.evaluate(() => !document.getElementById('hidden-groups'))) === true);

    // 再度非表示 → 再読込で永続化
    await page.click('#my-groups .g-row[data-id="7003"] .g-kebab');
    await page.click('.g-menu-item');
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: 'load' });
    await waitRows(page);
    ok(`${T} 再読込後も非表示が維持される`, JSON.stringify(await rowIds(page)) === JSON.stringify(['7001', '7002']), JSON.stringify(await rowIds(page)));
    ok(`${T} 再読込後も非表示一覧に残る`, JSON.stringify(await hiddenIds(page)) === JSON.stringify(['7003']), JSON.stringify(await hiddenIds(page)));

    // 非表示一覧から再表示（折りたたみを開いてから操作する）
    ok(`${T} 「${t.section}」は既定で折りたたまれている`, (await page.evaluate(() => document.getElementById('hidden-groups').open)) === false);
    await openHiddenSection(page);
    ok(`${T} 開くと非表示グループの名前を確認できる`, (await page.evaluate(() => {
      const n = document.querySelector('#my-groups .hg-item[data-id="7003"] .hg-name');
      return n ? n.textContent.trim() : '';
    })).length > 0);
    await page.click('#my-groups .hg-item[data-id="7003"] .hg-restore');
    await page.waitForTimeout(300);
    ok(`${T} 「${t.restore}」で通常一覧へ戻る`, (await rowIds(page)).includes('7003'), JSON.stringify(await rowIds(page)));
    ok(`${T} 再表示後は非表示一覧から消える`, (await page.evaluate(() => !document.getElementById('hidden-groups'))) === true);

    // 再表示後も再読込で維持
    await page.reload({ waitUntil: 'load' });
    await waitRows(page);
    ok(`${T} 再表示後も再読込で維持される`, JSON.stringify(await rowIds(page)) === JSON.stringify(['7001', '7002', '7003']), JSON.stringify(await rowIds(page)));

    // 全件非表示でも復元できる
    for (const id of ['7001', '7002', '7003']) {
      await page.click(`#my-groups .g-row[data-id="${id}"] .g-kebab`);
      await page.click('.g-menu-item');
      await page.waitForTimeout(200);
    }
    ok(`${T} 全件非表示でも非表示一覧から復元できる`, (await hiddenIds(page)).length === 3, JSON.stringify(await hiddenIds(page)));
    ok(`${T} 全件非表示のとき通常一覧は空表示になる`, (await rowIds(page)).length === 0, JSON.stringify(await rowIds(page)));
    await openHiddenSection(page);
    await page.click('#my-groups .hg-item[data-id="7001"] .hg-restore');
    await page.waitForTimeout(300);
    ok(`${T} 参加中0件からでも再表示できる`, JSON.stringify(await rowIds(page)) === JSON.stringify(['7001']), JSON.stringify(await rowIds(page)));

    // 文言の混在なし
    const bodyText = await page.evaluate(() => document.getElementById('my-groups').textContent);
    ok(`${T} 反対言語の文言が混在しない`, !t.foreign.test(bodyText), bodyText.slice(0, 160));

    // 通常のグループを開く操作が壊れていない
    await page.click('#my-groups .g-row[data-id="7001"] .g-item');
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 15000 });
    ok(`${T} 行タップで従来どおりグループを開ける`, (await page.evaluate(() => document.getElementById('p-main').classList.contains('show'))) === true);

    ok(`${T} 画像404が0件`, notFound.length === 0, JSON.stringify(notFound));
    ok(`${T} console errorが0件`, (await jsErrors(page)).length === 0, JSON.stringify(await jsErrors(page)));
    ok(`${T} Supabaseへの削除通信が0件`, state.deletes.length === 0, JSON.stringify(state.deletes));
    ok(`${T} Supabaseへの書込み通信が0件`, state.writes.length === 0, JSON.stringify(state.writes));
    await ctx.close();
  }

  // ---------- C/D. スマホ(390px)：左スワイプ→「非表示」ボタン（日英両方） ----------
  for (const lang of ['ja', 'en']) {
    const t = L[lang];
    const T = `[SP-${lang}]`;
    const state = makeCtxState();
    // 他スイートと同じ素の390pxビューポート。スワイプはポインタイベントで実装しているためマウス操作で再現できる
    const { ctx, page, notFound } = await newCtx(browser, { width: 390, height: 844 }, state);
    await page.goto(`http://localhost:${PORT}${t.base}`, { waitUntil: 'load' });
    await waitRows(page);

    ok(`${T} スマホでは「︙」が表示されない`, (await page.evaluate(() => getComputedStyle(document.querySelector('#my-groups .g-kebab')).display)) === 'none');
    ok(`${T} 非表示ボタンの文言が「${t.hideBtn}」`, (await page.evaluate(() => document.querySelector('#my-groups .g-hide-btn').textContent.trim())) === t.hideBtn);

    // 少しだけ横に触れても開かない（行の外で離してタップ遷移を避ける）
    const tinyTransform = await dragRow(page, '7002', -6, 0, true);
    ok(`${T} 少し横へ触れただけでは行が動かない`, tinyTransform === '', `transform=${tinyTransform}`);
    ok(`${T} 少し横へ触れただけでは開かない`, (await page.evaluate(() => !document.querySelector('#my-groups .g-row.g-open'))) === true);

    // 縦方向のドラッグでは開かない（縦スクロールを妨げない）
    const vertTransform = await dragRow(page, '7002', -30, -60, true);
    ok(`${T} 縦方向が優勢な操作では行が動かない`, vertTransform === '', `transform=${vertTransform}`);
    ok(`${T} 縦方向が優勢な操作では開かない`, (await page.evaluate(() => !document.querySelector('#my-groups .g-row.g-open'))) === true);

    // 左スワイプで開く
    await dragRow(page, '7002', -95, 0);
    ok(`${T} 左スワイプで非表示ボタンが現れる`, (await page.evaluate(() => !!document.querySelector('#my-groups .g-row[data-id="7002"].g-open'))) === true);
    ok(`${T} スワイプだけでは非表示にならない`, (await rowIds(page)).length === 3, JSON.stringify(await rowIds(page)));
    ok(`${T} スワイプだけでは保存もされない`, (await stored(page, t.key)) === null || (await stored(page, t.key)) === '[]', String(await stored(page, t.key)));

    // 同時に開くのは1行だけ（別の行をスワイプすると前の行は閉じる）
    await dragRow(page, '7003', -95, 0);
    ok(`${T} 同時に開ける行は1つだけ`, (await page.evaluate(() => document.querySelectorAll('#my-groups .g-row.g-open').length)) === 1);
    ok(`${T} 別の行を操作すると前に開いた行は閉じる`, (await page.evaluate(() => !!document.querySelector('#my-groups .g-row[data-id="7003"].g-open'))) === true);

    // 右へ戻してキャンセル
    await dragRow(page, '7003', 105, 0);
    ok(`${T} 右へ戻すとキャンセルできる`, (await page.evaluate(() => !document.querySelector('#my-groups .g-row.g-open'))) === true);

    // 縦方向の操作で開いている行が閉じる
    await dragRow(page, '7002', -95, 0);
    await dragRow(page, '7002', -10, -70, true);
    ok(`${T} 縦スクロール操作で開いている行が閉じる`, (await page.evaluate(() => !document.querySelector('#my-groups .g-row.g-open'))) === true);

    // 改めて左スワイプ→非表示ボタンをタップ
    await dragRow(page, '7002', -95, 0);
    const restBefore = state.rest.length;
    await page.click('#my-groups .g-row[data-id="7002"] .g-hide-btn');
    await page.waitForTimeout(400);
    ok(`${T} 非表示ボタンのタップで一覧から消える`, JSON.stringify(await rowIds(page)) === JSON.stringify(['7001', '7003']), JSON.stringify(await rowIds(page)));
    ok(`${T} 非表示操作でSupabaseへ通信しない`, state.rest.length - restBefore === 0, `calls=${state.rest.length - restBefore}`);
    ok(`${T} 参加中グループID(narika_gids)は消えない`, (await stored(page, 'narika_gids')) === JSON.stringify([7001, 7002, 7003]));
    ok(`${T} 「${t.toast}」通知が出る`, (await page.evaluate(() => { const e = document.querySelector('.toast-undo'); return e ? e.textContent : ''; })).includes(t.toast));

    await page.click('.toast-undo-btn');
    await page.waitForTimeout(300);
    ok(`${T} Undoで戻せる`, (await rowIds(page)).length === 3, JSON.stringify(await rowIds(page)));

    // 横スクロールが出ない（スワイプ後も）
    const noHoriz = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    ok(`${T} 390pxで横スクロールが発生しない`, noHoriz === true);

    // 既存漫画表示に回帰がない
    const manga = await page.evaluate(() => {
      const sec = document.getElementById('manga-section-ja') || document.getElementById('manga-section-en');
      if (!sec) return null;
      const imgs = [...sec.querySelectorAll('img.manga-img')];
      const grid = sec.querySelector('.manga-grid');
      return { count: imgs.length, cols: getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length };
    });
    ok(`${T} 漫画8枚が従来どおり表示される`, manga && manga.count === 8, JSON.stringify(manga));
    ok(`${T} 漫画はスマホで1列のまま`, manga && manga.cols === 1, JSON.stringify(manga));

    ok(`${T} 画像404が0件`, notFound.length === 0, JSON.stringify(notFound));
    ok(`${T} console errorが0件`, (await jsErrors(page)).length === 0, JSON.stringify(await jsErrors(page)));
    ok(`${T} Supabaseへの削除通信が0件`, state.deletes.length === 0, JSON.stringify(state.deletes));
    await ctx.close();
  }

  // ---------- E. 非表示中でも直接URLでグループを開ける（日英両方） ----------
  for (const lang of ['ja', 'en']) {
    const t = L[lang];
    const T = `[URL-${lang}]`;
    const state = makeCtxState();
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 1000 }, state);
    // 招待URLの初回紹介画面は既読にしておく（今回の検証対象ではない既存仕様）
    await ctx.addInitScript(k => {
      localStorage.setItem(k, JSON.stringify(['7002']));
      localStorage.setItem('narika_intro_seen_gids', JSON.stringify(['7001', '7002', '7003']));
    }, t.key);
    await page.goto(`http://localhost:${PORT}${t.base}?g=7002`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('p-main').classList.contains('show'), { timeout: 20000 });
    ok(`${T} 非表示中のグループも直接URLで開ける`, (await page.evaluate(() => document.getElementById('p-main').classList.contains('show'))) === true);
    ok(`${T} 非表示中の案内が表示される`, (await page.evaluate(() => {
      const el = document.getElementById('hidden-notice');
      return !!(el && el.classList.contains('show'));
    })) === true);
    ok(`${T} 案内文が「${t.notice}」`, (await page.evaluate(() => document.querySelector('#hidden-notice span').textContent.trim())) === t.notice);

    // 案内から再表示
    await page.click('#btn-hidden-notice-show');
    await page.waitForTimeout(300);
    ok(`${T} 案内から再表示すると保存から消える`, (await stored(page, t.key)) === '[]', String(await stored(page, t.key)));
    ok(`${T} 再表示後は案内が消える`, (await page.evaluate(() => !document.getElementById('hidden-notice').classList.contains('show'))) === true);
    ok(`${T} URL・グループIDは変わらない`, (await page.evaluate(() => location.search)).includes('g=7002'), await page.evaluate(() => location.search));
    ok(`${T} 直接URLでもDELETE通信は0件`, state.deletes.length === 0, JSON.stringify(state.deletes));
    ok(`${T} console errorが0件`, (await jsErrors(page)).length === 0, JSON.stringify(await jsErrors(page)));
    await ctx.close();
  }

  // ---------- F. 日英の非表示状態が分離されている ----------
  {
    const T = '[分離]';
    const state = makeCtxState();
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 1000 }, state);
    await page.goto(`http://localhost:${PORT}/ja/`, { waitUntil: 'load' });
    await waitRows(page);
    await page.click('#my-groups .g-row[data-id="7002"] .g-kebab');
    await page.click('.g-menu-item');
    await page.waitForTimeout(300);
    ok(`${T} 日本語版で非表示にすると日本語版から消える`, !(await rowIds(page)).includes('7002'), JSON.stringify(await rowIds(page)));

    await page.goto(`http://localhost:${PORT}/en/`, { waitUntil: 'load' });
    await waitRows(page);
    ok(`${T} 英語版の一覧には影響しない（3件のまま）`, (await rowIds(page)).length === 3, JSON.stringify(await rowIds(page)));
    ok(`${T} 英語版に非表示領域は出ない`, (await page.evaluate(() => !document.getElementById('hidden-groups'))) === true);
    ok(`${T} 日本語キーだけに保存されている`, (await stored(page, 'owesum_hidden_gids_ja')) === '["7002"]' && (await stored(page, 'owesum_hidden_gids_en')) === null,
      `ja=${await stored(page, 'owesum_hidden_gids_ja')} en=${await stored(page, 'owesum_hidden_gids_en')}`);
    ok(`${T} 参加中グループIDは日英共通のまま変わらない`, (await stored(page, 'narika_gids')) === JSON.stringify([7001, 7002, 7003]));
    await ctx.close();
  }

  // ---------- G. 保存値が壊れていても一覧全体をエラーにしない ----------
  for (const lang of ['ja', 'en']) {
    const t = L[lang];
    const T = `[破損-${lang}]`;
    for (const bad of ['{not json', '{"a":1}', '"abc"', 'null']) {
      const state = makeCtxState();
      const { ctx, page } = await newCtx(browser, { width: 1280, height: 1000 }, state);
      await ctx.addInitScript(([k, v]) => { localStorage.setItem(k, v); }, [t.key, bad]);
      await page.goto(`http://localhost:${PORT}${t.base}`, { waitUntil: 'load' });
      await waitRows(page);
      ok(`${T} 壊れた保存値(${bad})でも全件表示に戻る`, (await rowIds(page)).length === 3, JSON.stringify(await rowIds(page)));
      ok(`${T} 壊れた保存値(${bad})でconsole errorが出ない`, (await jsErrors(page)).length === 0, JSON.stringify(await jsErrors(page)));
      await ctx.close();
    }
  }

  // ---------- H. 通信安全 ----------
  ok('[通信] Supabase宛の発行数＝横取り数（本番到達0件）', NETG.supaObserved === NETG.supaHandledTotal, `observed=${NETG.supaObserved} handled=${NETG.supaHandledTotal}`);
  ok('[通信] Google向け通信が外部へ通過していない（実通信0）', NETG.gaObserved === NETG.gaCaptured, `observed=${NETG.gaObserved} captured=${NETG.gaCaptured}`);
  ok('[通信] 想定外の外部通信0件', NETG.otherExternal.length === 0, NETG.otherExternal.slice(0, 5).join(' || '));

  await browser.close();
  server.close();
  console.log(`[netguard] Google捕捉=${NETG.gaCaptured} Google外部通過=${NETG.gaObserved - NETG.gaCaptured} Supabase観測=${NETG.supaObserved} 想定外外部通信=${NETG.otherExternal.length}`);
  console.log(`\n==== グループ非表示・再表示E2E結果: PASS ${PASS} / FAIL ${FAIL} ====`);
  if (fails.length) { console.log('失敗一覧:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('E2E実行エラー:', e); process.exit(2); });

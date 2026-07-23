// OweSum 分け方（均等/割合/金額指定）E2Eテスト
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('C:\\Users\\narim\\trip-planner\\node_modules\\playwright');

const ROOT = 'C:\\Users\\narim\\narika';
const PORT = 8124;
const BASE = `http://localhost:${PORT}/index.html`;
const GNAME = 'OweSum分け方テスト(自動・削除予定)';
const SURL = 'https://bqlrtohnxwpswgqttqbs.supabase.co';
const SKEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxbHJ0b2hueHdwc3dncXR0cWJzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwNTEwODcsImV4cCI6MjA5NTYyNzA4N30.dZ6gXVHn_pTAnCUWIf1fqWNNRQfh2Jv8r7-mnmzrr9E';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}
async function waitToast(page, text) {
  try {
    await page.waitForSelector(`#toast-wrap .toast:has-text("${text}")`, { timeout: 6000 });
    return true;
  } catch (e) { return false; }
}
async function expectError(page, substr, name) {
  try {
    await page.waitForSelector('#modal-bg', { state: 'visible', timeout: 5000 });
  } catch (e) { check(name, false, 'エラーダイアログが出ない'); return; }
  const msg = await page.textContent('#modal-msg');
  check(name, msg.includes(substr), msg.replace(/\n/g, '⏎'));
  await page.click('#modal-ok');
  await page.waitForTimeout(250);
}
async function fillSplit(page, vals, prefix) {
  for (const [n, v] of Object.entries(vals)) {
    await page.fill(`#${prefix || 'split-detail'} [data-split-m="${n}"]`, v);
  }
}
async function pickCurrency(page, btnSel, code) {
  await page.click(btnSel);
  await page.fill('#cur-search', code);
  await page.waitForTimeout(200);
  await page.click(`#cur-list [data-cur="${code}"]`);
  await page.waitForTimeout(200);
}
async function restInsertExpense(row) {
  const res = await fetch(SURL + '/rest/v1/expenses', {
    method: 'POST',
    headers: { apikey: SKEY, Authorization: 'Bearer ' + SKEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error('REST insert失敗 ' + res.status + ' ' + await res.text());
  return (await res.json())[0];
}
async function deleteGroupViaUi(page, delGid) {
  if (await page.isVisible('#p-main.show')) {
    await page.click('.nb[data-tab="members"]');
    await page.waitForTimeout(200);
    await page.click('#btn-back');
    await page.waitForTimeout(1500);
  }
  const sel = `.g-item[data-id="${delGid}"]`;
  if (!(await page.locator(sel).count())) return;
  await page.click(sel);
  await page.waitForSelector('#p-main.show');
  await page.waitForTimeout(1500);
  const nm = await page.textContent('#g-title');
  await page.click('#btn-del-group');
  await page.waitForSelector('#modal-bg', { state: 'visible' });
  await page.click('#modal-ok');
  await page.waitForTimeout(300);
  await page.fill('#modal-input', nm);
  await page.click('#modal-ok');
  await page.waitForTimeout(2500);
}

(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html');
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end('nf'); return; }
      const ext = path.extname(p);
      const mime = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  }).listen(PORT);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 375, height: 720 },
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') jsErrors.push('[console.error] ' + m.text()); });

  let gid = null, restoredV2Gid = null, restoredV1Gid = null;

  try {
    // ===== A. セットアップ =====
    console.log('--- A. グループ作成・メンバー追加 ---');
    await page.goto(BASE);
    await page.waitForSelector('#btn-hero-create', { timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.click('#btn-hero-create');
    await page.waitForTimeout(400);
    await page.fill('#gname-modal', GNAME);
    await page.click('#create-ok');
    await page.waitForSelector('#p-main.show', { timeout: 15000 });
    await page.waitForTimeout(1500);
    gid = new URL(page.url()).searchParams.get('g');
    for (const n of ['まさと', 'みつこ', '陳さん']) {
      await page.fill('#inp-member', n);
      await page.click('#btn-add-member');
      await page.waitForTimeout(1200);
    }
    check('メンバー3人登録', (await page.textContent('#member-list')).includes('陳さん'));

    console.log('--- A2. メンバー名のカンマ拒否(24) ---');
    await page.fill('#inp-member', 'テスト,カンマ');
    await page.click('#btn-add-member');
    await expectError(page, 'メンバー名にカンマ「,」は使えません', '半角カンマ入り名前を拒否');
    await page.fill('#inp-member', 'テスト，全角');
    await page.click('#btn-add-member');
    await expectError(page, 'カンマ「,」は使えません', '全角カンマ入り名前を拒否');
    await page.fill('#inp-member', '');
    check('カンマ名は登録されていない', !(await page.textContent('#member-list')).includes('カンマ'));

    // ===== B. 登録画面の分け方UI =====
    console.log('--- B. 登録画面: 3方式と初期値(1,2) ---');
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(400);
    check('3方式のボタンが表示される', (await page.locator('#split-seg .sgb').count()) === 3);
    const segTxt = await page.textContent('#split-seg');
    check('均等・割合・金額指定の3種類', segTxt.includes('均等') && segTxt.includes('割合') && segTxt.includes('金額指定'));
    check('初期値は均等', await page.evaluate(() => document.querySelector('#split-seg .sgb.on').dataset.split === 'equal'));
    check('均等では追加入力欄なし', (await page.textContent('#split-detail')).trim() === '');
    check('分け方UIは受益者の直下', await page.evaluate(() => {
      const ben = document.getElementById('ben-chips').getBoundingClientRect();
      const seg = document.getElementById('split-seg').getBoundingClientRect();
      const btn = document.getElementById('btn-add-expense').getBoundingClientRect();
      return seg.top >= ben.bottom - 1 && seg.bottom <= btn.top + 1;
    }));

    console.log('--- C. 支払額の通貨小数桁(9,10) ---');
    await page.fill('#inp-ename', 'JPY小数テスト');
    await page.fill('#inp-eamt', '10.5');
    await page.click('#btn-add-expense');
    await expectError(page, 'JPY', 'JPYの小数金額を拒否');
    check('JPY小数は登録されない', !(await page.textContent('#exp-list')).includes('JPY小数テスト'));

    console.log('--- D. 均等: 1000円÷3人(12) ---');
    await page.fill('#inp-ename', '1次会：均等');
    await page.fill('#inp-eamt', '1000');
    await page.click('#btn-add-expense');
    check('均等1000円を登録', await waitToast(page, '支払いを登録しました'));
    await page.waitForTimeout(1500);

    console.log('--- E. 割合: 整数％の自動入力・バリデーション・登録 ---');
    await page.fill('#inp-ename', '2次会：割合');
    await page.fill('#inp-eamt', '100');
    await page.click('#split-seg .sgb[data-split="percentage"]');
    await page.waitForTimeout(300);
    check('割合選択で受益者ごとの入力欄', (await page.locator('#split-detail [data-split-m]').count()) === 3);
    check('割合入力欄はnumericキーボード', (await page.getAttribute('#split-detail [data-split-m="まさと"]', 'inputmode')) === 'numeric');
    check('割合入力欄はstep=1', (await page.getAttribute('#split-detail [data-split-m="まさと"]', 'step')) === '1');
    check('補助ボタン「均等割合にする」表示', (await page.textContent('#split-detail')).includes('均等割合にする'));
    check('割合注記が整数案内', (await page.textContent('#split-detail')).includes('1%刻みの整数'));

    // 割合モードへ切り替えた時点で、均等な整数％（3人=34/33/33、合計100）が自動入力される
    check('割合切替で自動入力: まさと34%', (await page.inputValue('#split-detail [data-split-m="まさと"]')) === '34');
    check('割合切替で自動入力: みつこ33%', (await page.inputValue('#split-detail [data-split-m="みつこ"]')) === '33');
    check('割合切替で自動入力: 陳さん33%', (await page.inputValue('#split-detail [data-split-m="陳さん"]')) === '33');
    check('自動入力後の合計が100%でOK色', await page.evaluate(() => {
      const el = document.querySelector('#split-detail [data-split-sum]');
      return el.textContent.includes('100%') && !el.classList.contains('ng');
    }));
    // 均等整数％の分配ロジック（純関数）: 3人34/33/33・4人25×4・6人17/17/17/17/16/16、いずれも合計100
    const evenCases = await page.evaluate(() => ({
      p3: evenPercentInts(3), p4: evenPercentInts(4), p6: evenPercentInts(6),
    }));
    check('均等整数％: 3人=34,33,33', JSON.stringify(evenCases.p3) === JSON.stringify([34, 33, 33]), JSON.stringify(evenCases.p3));
    check('均等整数％: 4人=25,25,25,25', JSON.stringify(evenCases.p4) === JSON.stringify([25, 25, 25, 25]), JSON.stringify(evenCases.p4));
    check('均等整数％: 6人=17,17,17,17,16,16', JSON.stringify(evenCases.p6) === JSON.stringify([17, 17, 17, 17, 16, 16]), JSON.stringify(evenCases.p6));
    check('均等整数％: いずれも合計100', [evenCases.p3, evenCases.p4, evenCases.p6].every(a => a.reduce((s, x) => s + x, 0) === 100));
    // 整数％→permille変換: 34%→340、33%→330、小数/0/負数/100超はnull
    const permilleMap = await page.evaluate(() => ({
      i34: parsePercentIntToPermille('34'), i33: parsePercentIntToPermille('33'),
      dec: parsePercentIntToPermille('33.3'), zero: parsePercentIntToPermille('0'),
      neg: parsePercentIntToPermille('-5'), over: parsePercentIntToPermille('101'),
    }));
    check('34%→share_permille 340', permilleMap.i34 === 340, String(permilleMap.i34));
    check('33%→share_permille 330', permilleMap.i33 === 330, String(permilleMap.i33));
    check('小数/0/負数/100超はnull', permilleMap.dec === null && permilleMap.zero === null && permilleMap.neg === null && permilleMap.over === null, JSON.stringify(permilleMap));

    // 手入力後は勝手に再配分しない：金額指定へ切替→割合へ戻しても手入力値を保持
    await fillSplit(page, { 'まさと': '40', 'みつこ': '30', '陳さん': '30' });
    await page.click('#split-seg .sgb[data-split="amount"]');
    await page.waitForTimeout(200);
    await page.click('#split-seg .sgb[data-split="percentage"]');
    await page.waitForTimeout(200);
    check('割合へ戻しても手入力値を保持（自動再配分しない）', (await page.inputValue('#split-detail [data-split-m="まさと"]')) === '40'
      && (await page.inputValue('#split-detail [data-split-m="みつこ"]')) === '30');

    // 「均等割合にする」で整数の均等（34/33/33）へ再配分
    await page.click('#split-detail [data-split-even]');
    await page.waitForTimeout(200);
    check('均等割合ボタン: まさと34%', (await page.inputValue('#split-detail [data-split-m="まさと"]')) === '34');
    check('均等割合ボタン: みつこ33%', (await page.inputValue('#split-detail [data-split-m="みつこ"]')) === '33');
    check('均等割合ボタン: 陳さん33%', (await page.inputValue('#split-detail [data-split-m="陳さん"]')) === '33');

    // 受益者の変更: 入力値維持・外した人は欄削除・合計不一致を表示（自動再配分しない）
    await page.click('#ben-chips .chip:has-text("陳さん")');
    await page.waitForTimeout(300);
    check('受益者を外すと入力欄が消える', (await page.locator('#split-detail [data-split-m]').count()) === 2);
    check('残った人の入力値は維持（自動再配分しない）', (await page.inputValue('#split-detail [data-split-m="まさと"]')) === '34');
    check('合計が合わなくなると赤字表示', await page.evaluate(() => document.querySelector('#split-detail [data-split-sum]').classList.contains('ng')));
    await page.click('#ben-chips .chip:has-text("陳さん")');
    await page.waitForTimeout(300);
    check('再選択した人は空欄で追加（自動再配分しない）', (await page.inputValue('#split-detail [data-split-m="陳さん"]')) === '');

    // 99% / 101% / 0% / 負数 / 空欄 / 小数（整数％のみ許可）
    await fillSplit(page, { 'まさと': '33', 'みつこ': '33', '陳さん': '33' });
    await page.click('#btn-add-expense');
    await expectError(page, '100%ではありません（現在 99%）', '割合99%を拒否');
    await fillSplit(page, { 'まさと': '34', 'みつこ': '34', '陳さん': '33' });
    await page.click('#btn-add-expense');
    await expectError(page, '100%ではありません（現在 101%）', '割合101%を拒否');
    await fillSplit(page, { 'まさと': '0', 'みつこ': '50', '陳さん': '50' });
    await page.click('#btn-add-expense');
    await expectError(page, 'まさとの割合が正しくありません', '割合0%を拒否');
    await fillSplit(page, { 'まさと': '-10', 'みつこ': '60', '陳さん': '50' });
    await page.click('#btn-add-expense');
    await expectError(page, '割合が正しくありません', '割合の負数を拒否');
    await fillSplit(page, { 'まさと': '50', 'みつこ': '50', '陳さん': '' });
    await page.click('#btn-add-expense');
    await expectError(page, '陳さんの割合を入力してください', '割合の空欄を拒否');
    // 小数％は不可（整数のみ）
    await fillSplit(page, { 'まさと': '33.3', 'みつこ': '33.3', '陳さん': '33.4' });
    await page.click('#btn-add-expense');
    await expectError(page, '整数（％）で入力してください', '割合の小数を拒否');
    await fillSplit(page, { 'まさと': '33.5', 'みつこ': '33', '陳さん': '33.5' });
    await page.click('#btn-add-expense');
    await expectError(page, '整数（％）で入力してください', '割合の小数0.5刻みも拒否');
    // 全角入力の正規化（整数）
    await page.fill('#split-detail [data-split-m="陳さん"]', '');
    await page.type('#split-detail [data-split-m="陳さん"]', '３４');
    check('割合欄で全角→半角', (await page.inputValue('#split-detail [data-split-m="陳さん"]')) === '34');
    await fillSplit(page, { 'まさと': '33', 'みつこ': '33' });
    await page.click('#btn-add-expense');
    check('割合100%（整数：33/33/34）で登録できる', await waitToast(page, '支払いを登録しました'));
    await page.waitForTimeout(1500);
    check('登録後は均等に戻る', await page.evaluate(() => document.querySelector('#split-seg .sgb.on').dataset.split === 'equal'));

    console.log('--- F. 金額指定: バリデーション(7,8)と登録(6) ---');
    await page.fill('#inp-ename', 'タクシー：金額指定');
    await page.fill('#inp-eamt', '10000');
    await page.click('#split-seg .sgb[data-split="amount"]');
    await page.waitForTimeout(300);
    check('金額指定で受益者ごとの入力欄', (await page.locator('#split-detail [data-split-m]').count()) === 3);
    check('補助ボタン「均等に配分する」表示', (await page.textContent('#split-detail')).includes('均等に配分する'));
    await page.click('#split-detail [data-split-even]');
    await page.waitForTimeout(200);
    check('均等配分: まさと3,334', (await page.inputValue('#split-detail [data-split-m="まさと"]')) === '3,334');
    check('均等配分: 陳さん3,333', (await page.inputValue('#split-detail [data-split-m="陳さん"]')) === '3,333');

    // 通貨変更で金額指定は再入力
    await pickCurrency(page, '#inp-ecur-btn', 'USD');
    check('通貨変更で金額指定欄がクリア', (await page.inputValue('#split-detail [data-split-m="まさと"]')) === '');
    check('単位表示がUSDに変わる', (await page.textContent('#split-detail')).includes('USD'));
    await pickCurrency(page, '#inp-ecur-btn', 'JPY');

    await fillSplit(page, { 'まさと': '5000', 'みつこ': '3000', '陳さん': '1000' });
    await page.click('#btn-add-expense');
    await expectError(page, '一致しません', '金額不足を拒否');
    await fillSplit(page, { 'まさと': '5000', 'みつこ': '3000', '陳さん': '3000' });
    await page.click('#btn-add-expense');
    await expectError(page, '一致しません', '金額超過を拒否');
    await fillSplit(page, { 'まさと': '0', 'みつこ': '5000', '陳さん': '5000' });
    await page.click('#btn-add-expense');
    await expectError(page, 'まさとの負担額が正しくありません', '0円を拒否');
    await fillSplit(page, { 'まさと': '-100', 'みつこ': '5100', '陳さん': '5000' });
    await page.click('#btn-add-expense');
    await expectError(page, '負担額が正しくありません', '負数を拒否');
    await fillSplit(page, { 'まさと': '5000', 'みつこ': '5000', '陳さん': '' });
    await page.click('#btn-add-expense');
    await expectError(page, '陳さんの負担額を入力してください', '空欄を拒否');
    // 3桁区切り表示（blurで整形）
    await page.fill('#split-detail [data-split-m="まさと"]', '5000');
    await page.dispatchEvent('#split-detail [data-split-m="まさと"]', 'blur');
    await page.waitForTimeout(100);
    check('金額指定欄は3桁区切り表示', (await page.inputValue('#split-detail [data-split-m="まさと"]')) === '5,000');
    // 支払額を変更すると保存不可＋赤字
    await fillSplit(page, { 'みつこ': '3000', '陳さん': '2000' });
    await page.fill('#inp-eamt', '9000');
    await page.waitForTimeout(200);
    check('支払額変更で合計が赤字表示', await page.evaluate(() => document.querySelector('#split-detail [data-split-sum]').classList.contains('ng')));
    await page.click('#btn-add-expense');
    await expectError(page, '一致しません', '支払額変更後は保存不可');
    await page.fill('#inp-eamt', '10000');
    await page.waitForTimeout(200);
    check('支払額を戻すと合計OK表示', await page.evaluate(() => !document.querySelector('#split-detail [data-split-sum]').classList.contains('ng')));
    await page.click('#btn-add-expense');
    check('金額合計一致で登録できる', await waitToast(page, '支払いを登録しました'));
    await page.waitForTimeout(1500);

    console.log('--- G. USD: 小数2桁許可・3桁拒否(10) ---');
    await page.fill('#inp-ename', 'USドル支払い');
    await pickCurrency(page, '#inp-ecur-btn', 'USD');
    await page.fill('#inp-eamt', '10.505');
    await page.click('#btn-add-expense');
    await expectError(page, 'USD', 'USDの小数3桁を拒否');
    await page.fill('#inp-eamt', '10.50');
    await page.click('#btn-add-expense');
    check('USDの小数2桁は登録できる', await waitToast(page, '支払いを登録しました'));
    await page.waitForTimeout(1500);
    await pickCurrency(page, '#inp-ecur-btn', 'JPY');

    console.log('--- H. 為替入力 → 精算(12,13,14,15,16) ---');
    await page.click('.nb[data-tab="rates"]');
    await page.waitForTimeout(500);
    // USDの為替が未入力の段階では金額を確定できないため共有不可
    check('為替未入力時はcanShare=false', (await page.evaluate(() => computeSettlements().canShare)) === false);
    await page.fill('#rate-list [data-rc="USD"]', '150');
    await page.dispatchEvent('#rate-list [data-rc="USD"]', 'change');
    await page.waitForTimeout(1500);
    await page.click('.nb[data-tab="settle"]');
    await page.waitForTimeout(800);
    // 期待値: E1均等1000(334/333/333) + E2割合100(33/33/34) + E3金額指定10000(5000/3000/2000) + E4 USD10.50均等(rate150=1575円,各525円)
    // まさと+6783 みつこ-3891 陳さん-2892 合計12675円
    check('合計支出12,675円（分け方混在）', (await page.textContent('#s-total')) === '12,675円', await page.textContent('#s-total'));
    const settleTxt = await page.textContent('#s-result');
    check('精算: みつこ→まさと3,891円', settleTxt.includes('3,891円'), settleTxt);
    check('精算: 陳さん→まさと2,892円', settleTxt.includes('2,892円'), settleTxt);
    const balTxt = await page.textContent('#s-balance');
    check('個人収支: まさと+6,783円（支払者本人も受益者）', balTxt.includes('+6,783円'), balTxt);
    check('正常データでは分け方警告なし', !(await page.isVisible('#s-split-warn')));
    check('精算画面にInfinity/NaNなし', !settleTxt.includes('Infinity') && !settleTxt.includes('NaN') && !balTxt.includes('NaN'));

    console.log('--- H2. 精算結果の共有（混在データで金額一致） ---');
    check('精算画面に「精算結果を共有」ボタン', await page.isVisible('#btn-share-settle') && (await page.textContent('#btn-share-settle')).includes('精算結果を共有'));
    // 共通計算(computeSettlements)と共有テキスト(buildSettleShareText)の整合を検証
    const shareInfo = await page.evaluate((gid) => {
      const v = computeSettlements();
      const gname = document.getElementById('g-title').textContent;
      const url = buildInviteUrl(gid);
      const text = buildSettleShareText(gname, v.settles, url);
      return { canShare: v.canShare, settles: v.settles, text, url, gname };
    }, gid);
    check('混在データで共有可能(canShare=true)', shareInfo.canShare === true, JSON.stringify(shareInfo.settles));
    check('共有: 送金は2件（みつこ→まさと / 陳さん→まさと）', shareInfo.settles.length === 2, JSON.stringify(shareInfo.settles));
    check('共有文の先頭が結論見出し', shareInfo.text.startsWith(`【OweSum｜${shareInfo.gname}の精算結果】`), shareInfo.text.slice(0, 60));
    check('共有文にみつこ→まさと3,891円', shareInfo.text.includes('みつこ → まさと：3,891円'), shareInfo.text);
    check('共有文に陳さん→まさと2,892円', shareInfo.text.includes('陳さん → まさと：2,892円'), shareInfo.text);
    check('各送金額が画面表示(settleTxt)と一致', settleTxt.includes('3,891円') && settleTxt.includes('2,892円') && shareInfo.text.includes('3,891円') && shareInfo.text.includes('2,892円'));
    check('結論の下に「詳細はこちら」', /みつこ → まさと：3,891円[\s\S]*詳細はこちら/.test(shareInfo.text), shareInfo.text);
    check('本文末尾がグループURL', shareInfo.text.trim().endsWith(shareInfo.url), shareInfo.text.slice(-120));
    check('URLは本文に1つだけ', shareInfo.text.split(shareInfo.url).length - 1 === 1, shareInfo.text);
    check('URLに正しいグループIDが含まれる', shareInfo.url.includes('?g=' + gid), shareInfo.url);
    check('「詳細はこちら」の直後がURL', shareInfo.text.includes('詳細はこちら\n' + shareInfo.url), shareInfo.text.slice(-160));
    // navigator.share非対応環境（PC/headless）はクリップボードへコピー
    await page.click('#btn-share-settle');
    check('共有: コピー完了トースト', await waitToast(page, '精算結果をコピーしました'));
    const clipSettle = await page.evaluate(() => navigator.clipboard.readText());
    // WindowsのクリップボードはreadTextで改行を\r\nへ正規化するため、比較時に揃える
    check('クリップボードが共有文と一致', clipSettle.replace(/\r\n/g, '\n') === shareInfo.text, `clip=${JSON.stringify(clipSettle.slice(0, 60))}`);

    console.log('--- H3. 精算共有: navigator.share にタイトル・本文（URL含む）を渡す / キャンセル安全 ---');
    const IOSUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    async function enterGroupPage(pg) {
      await pg.waitForSelector('#p-intro.show, #p-main.show', { timeout: 15000 });
      if (await pg.isVisible('#p-intro.show')) { await pg.click('#btn-intro-open'); await pg.waitForSelector('#p-main.show', { timeout: 15000 }); }
      await pg.waitForTimeout(1500);
      await pg.click('.nb[data-tab="settle"]');
      await pg.waitForTimeout(800);
    }
    const ctxShare = await browser.newContext({ viewport: { width: 375, height: 720 }, userAgent: IOSUA });
    await ctxShare.addInitScript(() => {
      window.__settleShare = [];
      navigator.share = (d) => { window.__settleShare.push({ title: d.title, text: d.text, url: d.url }); return Promise.resolve(); };
    });
    const psh = await ctxShare.newPage();
    psh.on('pageerror', e => jsErrors.push('[settleShare] ' + String(e)));
    await psh.goto(BASE + '?g=' + gid);
    await enterGroupPage(psh);
    await psh.click('#btn-share-settle');
    await psh.waitForTimeout(300);
    const sc = await psh.evaluate(() => window.__settleShare);
    check('精算共有: navigator.shareが1回呼ばれる', sc.length === 1, JSON.stringify(sc));
    check('精算共有: タイトルは「OweSum「グループ名」の精算結果」', sc[0] && sc[0].title === `OweSum「${GNAME}」の精算結果`, sc[0] && sc[0].title);
    check('精算共有: 本文先頭が結論見出し', sc[0] && sc[0].text.startsWith(`【OweSum｜${GNAME}の精算結果】`), sc[0] && sc[0].text.slice(0, 40));
    check('精算共有: 本文にURLが含まれる（url項目だけに頼らない）', sc[0] && sc[0].text.includes('?g=' + gid), sc[0] && sc[0].text);
    check('精算共有: 本文に送金額（3,891円）が含まれる', sc[0] && sc[0].text.includes('3,891円'), sc[0] && sc[0].text);
    await ctxShare.close();
    // キャンセル（AbortError）ではエラー表示を出さない
    const ctxCancel = await browser.newContext({ viewport: { width: 375, height: 720 }, userAgent: IOSUA });
    await ctxCancel.addInitScript(() => { navigator.share = () => Promise.reject(Object.assign(new Error('cancel'), { name: 'AbortError' })); });
    const pcn = await ctxCancel.newPage();
    const cancelErrors = [];
    pcn.on('pageerror', e => cancelErrors.push(String(e)));
    await pcn.goto(BASE + '?g=' + gid);
    await enterGroupPage(pcn);
    await pcn.click('#btn-share-settle');
    await pcn.waitForTimeout(600);
    check('精算共有キャンセル: エラー・確認ダイアログが出ない', cancelErrors.length === 0 && !(await pcn.isVisible('#modal-bg')));
    check('精算共有キャンセル: エラートーストが出ない', (await pcn.locator('#toast-wrap .toast-error').count()) === 0);
    await ctxCancel.close();

    console.log('--- I. 一覧カードのタグと内訳(25) ---');
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(500);
    const pctCard = await page.textContent('.card:has-text("2次会：割合")');
    check('割合タグ表示', pctCard.includes('割合'));
    check('割合の内訳表示', pctCard.includes('まさと33%') && pctCard.includes('みつこ33%') && pctCard.includes('陳さん34%'), pctCard);
    const amtCard = await page.textContent('.card:has-text("タクシー：金額指定")');
    check('金額指定タグ表示', amtCard.includes('金額指定'));
    check('金額指定の内訳表示', amtCard.includes('まさと5,000') && amtCard.includes('みつこ3,000') && amtCard.includes('陳さん2,000'), amtCard);
    const eqCard = await page.textContent('.card:has-text("1次会：均等")');
    check('均等カードは従来表示（全員バッジ）', eqCard.includes('全員'));

    console.log('--- J. 共有テキストに内訳(26) ---');
    await page.click('.nb[data-tab="members"]');
    await page.waitForTimeout(300);
    await page.click('#btn-share');
    await page.waitForSelector('#modal-bg', { state: 'visible' });
    await page.click('#modal-ok');
    const clipRec = await page.evaluate(() => navigator.clipboard.readText());
    check('共有: 割合の内訳1行（受益者→参加者に変更）', clipRec.includes('参加者：まさと33%・みつこ33%・陳さん34%'), clipRec.slice(0, 400));
    check('共有テキストに旧「受益者」表記が残っていない', !clipRec.includes('受益者'), clipRec.slice(0, 400));
    check('共有: 金額指定の内訳1行', clipRec.includes('負担額：まさと5,000・みつこ3,000・陳さん2,000'));
    check('共有: 精算結果が共通計算と一致', clipRec.includes('合計：12,675円'));

    console.log('--- K. 編集画面: 方式と値の復元(11) ---');
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(400);
    await page.click('.card:has-text("2次会：割合") [data-edit]');
    await page.waitForTimeout(400);
    check('編集: 割合が選択された状態で開く', await page.evaluate(() => document.querySelector('#ed-split-seg .sgb.on').dataset.split === 'percentage'));
    check('編集: 保存済みの割合を表示', (await page.inputValue('#ed-split-detail [data-split-m="まさと"]')) === '33'
      && (await page.inputValue('#ed-split-detail [data-split-m="陳さん"]')) === '34');
    check('編集画面にも3方式', (await page.locator('#ed-split-seg .sgb').count()) === 3);
    await page.click('#ed-cancel');
    await page.waitForTimeout(200);
    await page.click('.card:has-text("タクシー：金額指定") [data-edit]');
    await page.waitForTimeout(400);
    check('編集: 金額指定が選択された状態で開く', await page.evaluate(() => document.querySelector('#ed-split-seg .sgb.on').dataset.split === 'amount'));
    check('編集: 保存済みの金額を表示', (await page.inputValue('#ed-split-detail [data-split-m="まさと"]')) === '5,000'
      && (await page.inputValue('#ed-split-detail [data-split-m="陳さん"]')) === '2,000');
    await page.click('#ed-cancel');
    await page.waitForTimeout(200);
    // 均等の支払いは均等で開き、方式を変更できる
    await page.click('.card:has-text("1次会：均等") [data-edit]');
    await page.waitForTimeout(400);
    check('編集: 均等支払いは均等で開く', await page.evaluate(() => document.querySelector('#ed-split-seg .sgb.on').dataset.split === 'equal'));
    await page.click('#ed-split-seg .sgb[data-split="percentage"]');
    await page.waitForTimeout(300);
    await fillSplit(page, { 'まさと': '50', 'みつこ': '30', '陳さん': '20' }, 'ed-split-detail');
    await page.click('#ed-save');
    check('編集: 均等→割合へ変更して保存', await waitToast(page, '支払いを保存しました'));
    await page.waitForTimeout(1500);
    const pctCard2 = await page.textContent('.card:has-text("1次会：均等")');
    check('変更後カードに割合内訳', pctCard2.includes('まさと50%') && pctCard2.includes('みつこ30%') && pctCard2.includes('陳さん20%'), pctCard2);
    await page.click('.card:has-text("1次会：均等") [data-edit]');
    await page.waitForTimeout(400);
    check('再編集で50/30/20が復元', (await page.inputValue('#ed-split-detail [data-split-m="まさと"]')) === '50'
      && (await page.inputValue('#ed-split-detail [data-split-m="みつこ"]')) === '30');
    await page.click('#ed-split-seg .sgb[data-split="equal"]');
    await page.waitForTimeout(200);
    await page.click('#ed-save');
    check('編集: 割合→均等へ戻して保存', await waitToast(page, '支払いを保存しました'));
    await page.waitForTimeout(1500);

    console.log('--- L. バックアップversion 2(20の前半) ---');
    await page.click('.nb[data-tab="members"]');
    await page.waitForTimeout(300);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }),
      page.click('#btn-backup-json'),
    ]);
    const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    check('バックアップversion=2', backup.version === 2);
    const bkEq = backup.expenses.find(e => e.name === '1次会：均等');
    const bkPct = backup.expenses.find(e => e.name === '2次会：割合');
    const bkAmt = backup.expenses.find(e => e.name === 'タクシー：金額指定');
    check('均等はsplit_mode省略可', bkEq && !('split_mode' in bkEq));
    check('割合はsplit_mode/detailsを完全出力', bkPct && bkPct.split_mode === 'percentage'
      && Array.isArray(bkPct.split_details) && bkPct.split_details.reduce((s, x) => s + x.share_permille, 0) === 1000);
    check('金額指定はsplit_mode/detailsを完全出力', bkAmt && bkAmt.split_mode === 'amount'
      && Array.isArray(bkAmt.split_details) && bkAmt.split_details.reduce((s, x) => s + x.amount_minor, 0) === 10000);
    const v2Path = path.join(__dirname, 'restore_v2.json');
    fs.writeFileSync(v2Path, JSON.stringify(backup));

    console.log('--- M. 省略表示（5人の金額指定） ---');
    await page.click('.nb[data-tab="members"]');
    for (const n of ['けん', 'ゆき']) {
      await page.fill('#inp-member', n);
      await page.click('#btn-add-member');
      await page.waitForTimeout(1200);
    }
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(400);
    await page.fill('#inp-ename', '5人金額指定');
    await page.fill('#inp-eamt', '10000');
    await page.click('#split-seg .sgb[data-split="amount"]');
    await page.waitForTimeout(300);
    await fillSplit(page, { 'まさと': '2000', 'みつこ': '2000', '陳さん': '2000', 'けん': '2000', 'ゆき': '2000' });
    await page.click('#btn-add-expense');
    check('5人の金額指定を登録', await waitToast(page, '支払いを登録しました'));
    await page.waitForTimeout(1500);
    const bigCard = await page.textContent('.card:has-text("5人金額指定")');
    check('4人目以降は「ほか2人」で省略', bigCard.includes('ほか2人'), bigCard);
    check('省略時も最初の3人は表示', bigCard.includes('まさと2,000') && bigCard.includes('陳さん2,000'));
    await page.click('.card:has-text("5人金額指定") [data-edit]');
    await page.waitForTimeout(400);
    check('編集画面では全員分を表示', (await page.locator('#ed-split-detail [data-split-m]').count()) === 5);
    await page.click('#ed-cancel');
    await page.waitForTimeout(200);

    console.log('--- N. 不正データへのフォールバック(17,18) ---');
    const today = new Date().toISOString().split('T')[0];
    // 受益者0人
    await restInsertExpense({ group_id: gid, name: '受益者ゼロ', date: today, amount: 500, currency: 'JPY', payer: 'まさと', beneficiaries: '', split_mode: 'equal', split_details: null });
    // 割合が受益者と不一致（配列形状は正しいが中身が不正）
    await restInsertExpense({ group_id: gid, name: '壊れた割合', date: today, amount: 600, currency: 'JPY', payer: 'まさと', beneficiaries: 'まさと,みつこ,陳さん', split_mode: 'percentage', split_details: [{ member: 'まさと', share_permille: 500 }, { member: 'みつこ', share_permille: 400 }] });
    // 旧データ相当（split列を送らない→DBデフォルトequal）
    await restInsertExpense({ group_id: gid, name: '旧形式の支払い', date: today, amount: 900, currency: 'JPY', payer: 'まさと', beneficiaries: 'まさと,みつこ,陳さん' });
    await page.reload();
    await page.waitForSelector('#p-main.show', { timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(800);
    const brokenCard = await page.textContent('.card:has-text("壊れた割合")');
    check('不正な割合カードに要確認タグ', brokenCard.includes('要確認'), brokenCard);
    const zeroCard = await page.textContent('.card:has-text("受益者ゼロ")');
    check('受益者0人カードに要確認タグ', zeroCard.includes('要確認'), zeroCard);
    const oldCard = await page.textContent('.card:has-text("旧形式の支払い")');
    check('旧データは均等扱い（要確認・タグなしで受益者表示）', !oldCard.includes('要確認') && !oldCard.includes('金額指定')
      && oldCard.includes('まさと') && oldCard.includes('陳さん'), oldCard);
    await page.click('.nb[data-tab="settle"]');
    await page.waitForTimeout(800);
    check('精算画面に均等フォールバック警告', (await page.isVisible('#s-split-warn'))
      && (await page.textContent('#s-split-warn')).includes('均等として計算しています'));
    check('参加者0人の除外警告（受益者→参加者に変更）', (await page.textContent('#s-split-warn')).includes('参加者がいない') && (await page.textContent('#s-split-warn')).includes('除外'));
    const settleTxt2 = (await page.textContent('#s-result')) + (await page.textContent('#s-balance')) + (await page.textContent('#s-total'));
    check('不正データでもInfinity/NaNなし', !settleTxt2.includes('Infinity') && !settleTxt2.includes('NaN'), settleTxt2.slice(0, 200));
    // 要確認警告があるときは金額を確定できないため共有不可
    check('要確認警告時はcanShare=false', (await page.evaluate(() => computeSettlements().canShare)) === false);
    await page.click('#btn-share-settle');
    check('要確認警告時は共有せず案内トースト', await waitToast(page, '精算結果を確認してから共有してください'));

    console.log('--- N2. 既存の小数割合データ（0.1%刻み）の互換性 ---');
    // 旧仕様で保存された小数％データ（33.3/33.3/33.4 = permille 333/333/334, 合計1000）を直接投入
    await restInsertExpense({ group_id: gid, name: '旧小数割合', date: today, amount: 1000, currency: 'JPY', payer: 'みつこ', beneficiaries: 'まさと,みつこ,陳さん', split_mode: 'percentage', split_details: [{ member: 'まさと', share_permille: 333 }, { member: 'みつこ', share_permille: 333 }, { member: '陳さん', share_permille: 334 }] });
    await page.reload();
    await page.waitForSelector('#p-main.show', { timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(800);
    const legacyCard = await page.textContent('.card:has-text("旧小数割合")');
    check('旧小数割合: 読み込み表示は小数のまま保持', legacyCard.includes('まさと33.3%') && legacyCard.includes('陳さん33.4%'), legacyCard);
    check('旧小数割合: 有効データなので要確認タグは出ない', !legacyCard.includes('要確認'));
    // 精算が壊れない（1000JPYを333/333/334で配分＝333/333/334、支払者みつこ）
    await page.click('.nb[data-tab="settle"]');
    await page.waitForTimeout(800);
    const legSettle = (await page.textContent('#s-result')) + (await page.textContent('#s-balance')) + (await page.textContent('#s-total'));
    check('旧小数割合でも精算にInfinity/NaNなし', !legSettle.includes('Infinity') && !legSettle.includes('NaN'), legSettle.slice(0, 200));
    // 編集で開くと小数値は保持され（勝手に変えない）、整数のみ許可のため未修正では保存不可
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(400);
    await page.click('.card:has-text("旧小数割合") [data-edit]');
    await page.waitForTimeout(400);
    check('旧小数割合: 編集で小数値をそのまま表示（勝手に変えない）', (await page.inputValue('#ed-split-detail [data-split-m="まさと"]')) === '33.3'
      && (await page.inputValue('#ed-split-detail [data-split-m="陳さん"]')) === '33.4');
    check('旧小数割合: 編集画面の合計は整数不一致で赤字表示', await page.evaluate(() => document.querySelector('#ed-split-detail [data-split-sum]').classList.contains('ng')));
    await page.click('#ed-save');
    await expectError(page, '整数（％）で入力してください', '旧小数割合は未修正のまま保存できない');
    // エラーダイアログが編集ダイアログの手前に出て操作できる（z-index回帰確認）
    check('編集中のエラーダイアログを閉じても編集ダイアログは継続', await page.isVisible('#edit-bg'));
    // 整数へ直せば保存できる
    await fillSplit(page, { 'まさと': '33', 'みつこ': '33', '陳さん': '34' }, 'ed-split-detail');
    await page.click('#ed-save');
    check('旧小数割合: 整数へ直せば保存できる', await waitToast(page, '支払いを保存しました'));
    await page.waitForTimeout(1500);

    console.log('--- O. Realtime反映(27) ---');
    // 注意: 本番Supabaseでexpenses等のRealtime(publication)が無効のため、サーバーからのpush通知は届かない。
    // ここではアプリ側の購読が正しく確立されること＋別タブがDB経由で最新データを表示できることを検証する。
    const page2 = await context.newPage();
    page2.on('pageerror', e => jsErrors.push('[page2] ' + String(e)));
    const wsJoins = [], wsSystem = [];
    page2.on('websocket', ws => {
      ws.on('framesent', f => { const s = String(f.payload); if (s.includes('phx_join')) wsJoins.push(s.slice(0, 80)); });
      ws.on('framereceived', f => { const s = String(f.payload); if (s.includes('"system"')) wsSystem.push(s.slice(0, 200)); });
    });
    await page2.goto(BASE + '?g=' + gid);
    await page2.waitForSelector('#p-main.show', { timeout: 15000 });
    await page2.click('.nb[data-tab="expenses"]');
    await page2.waitForTimeout(4000); // Realtime購読の確立待ち
    check('別タブがexpenses変更チャンネルを購読', wsJoins.some(s => s.includes('realtime:e' + gid)), wsJoins.join(' | '));
    const rtServerDisabled = wsSystem.some(s => s.includes('Unable to subscribe'));
    console.log('  Realtimeサーバー状態: ' + (rtServerDisabled ? '無効（Supabase側でRealtime未有効化。DB設定変更が必要）' : '有効'));
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(400);
    await page.fill('#inp-ename', 'リアルタイム検証');
    await page.fill('#inp-eamt', '300');
    await page.click('#btn-add-expense');
    await waitToast(page, '支払いを登録しました');
    let rtOk = false;
    try {
      await page2.waitForSelector('#exp-list .card:has-text("リアルタイム検証")', { timeout: 10000 });
      rtOk = true;
    } catch (e) { }
    if (rtOk) {
      check('別タブにRealtimeで支払いが反映', true);
    } else {
      check('Realtime未有効の環境である（アプリ側購読は正常）', rtServerDisabled, wsSystem.join(' | '));
      await page2.reload();
      await page2.waitForSelector('#p-main.show', { timeout: 15000 });
      await page2.click('.nb[data-tab="expenses"]');
      await page2.waitForTimeout(1500);
      check('別タブでも再読込で支払いが共有される', (await page2.textContent('#exp-list')).includes('リアルタイム検証'));
    }
    await page2.close();

    console.log('--- P. 復元: version検証(19,20,21,22,23) ---');
    await page.click('.nb[data-tab="members"]');
    await page.waitForTimeout(200);
    await page.click('#btn-back');
    await page.waitForTimeout(1500);
    const groupCount = await page.locator('.g-item').count();

    // version 2 復元 → 方式と値が戻る
    await page.setInputFiles('#restore-file', v2Path);
    await page.waitForSelector('#modal-bg', { state: 'visible', timeout: 5000 });
    await page.click('#modal-ok'); // 復元します
    await page.waitForTimeout(3500);
    await page.click('#modal-ok'); // 復元しました
    await page.waitForSelector('#p-main.show', { timeout: 15000 });
    await page.waitForTimeout(2000);
    restoredV2Gid = new URL(page.url()).searchParams.get('g');
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(1000);
    const rPctCard = await page.textContent('.card:has-text("2次会：割合")');
    check('v2復元: 割合タグと内訳が戻る', rPctCard.includes('割合') && rPctCard.includes('まさと33%'), rPctCard);
    await page.click('.card:has-text("タクシー：金額指定") [data-edit]');
    await page.waitForTimeout(400);
    check('v2復元: 編集で金額指定の値が戻る', await page.evaluate(() => document.querySelector('#ed-split-seg .sgb.on').dataset.split === 'amount')
      && (await page.inputValue('#ed-split-detail [data-split-m="まさと"]')) === '5,000');
    await page.click('#ed-cancel');
    await page.waitForTimeout(200);
    await page.click('.nb[data-tab="members"]');
    await page.waitForTimeout(300);
    await page.click('#btn-back');
    await page.waitForTimeout(1500);

    // version 1 復元 → 全支払い均等扱い
    const v1Path = path.join(__dirname, 'restore_v1.json');
    fs.writeFileSync(v1Path, JSON.stringify({
      app: 'narika', version: 1, group_name: 'OweSum v1復元(自動・削除予定)',
      members: [{ name: 'まさと' }, { name: 'みつこ' }],
      expenses: [{ name: '旧支払い', date: '2026-07-20', amount: 1000, currency: 'JPY', payer: 'まさと', beneficiaries: 'まさと,みつこ' }],
      rates: {},
    }));
    await page.setInputFiles('#restore-file', v1Path);
    await page.waitForSelector('#modal-bg', { state: 'visible', timeout: 5000 });
    await page.click('#modal-ok');
    await page.waitForTimeout(3500);
    await page.click('#modal-ok');
    await page.waitForSelector('#p-main.show', { timeout: 15000 });
    await page.waitForTimeout(2000);
    restoredV1Gid = new URL(page.url()).searchParams.get('g');
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(1000);
    check('v1復元: 支払いが均等扱い（全員表示・タグなし）', (await page.textContent('.card:has-text("旧支払い")')).includes('全員'));
    await page.click('.nb[data-tab="settle"]');
    await page.waitForTimeout(800);
    check('v1復元: 精算500円（1000円÷2人）', (await page.textContent('#s-result')).includes('500円'));
    await page.click('.nb[data-tab="members"]');
    await page.waitForTimeout(200);
    await page.click('#btn-back');
    await page.waitForTimeout(1500);

    // versionなし → v1として受理（確認ダイアログまで進む→キャンセル）
    const noVerPath = path.join(__dirname, 'restore_nover.json');
    const { version, ...noVer } = JSON.parse(fs.readFileSync(v1Path, 'utf8'));
    fs.writeFileSync(noVerPath, JSON.stringify(noVer));
    await page.setInputFiles('#restore-file', noVerPath);
    await page.waitForSelector('#modal-bg', { state: 'visible', timeout: 5000 });
    check('versionなしはv1として受理（確認へ進む）', (await page.textContent('#modal-msg')).includes('復元します'));
    await page.click('#modal-cancel');
    await page.waitForTimeout(500);

    // version 3以上・不正versionは復元開始前に拒否
    const badVers = [[3, 'version3'], ['2', '文字列version'], [1.5, '小数version'], [-1, '負数version'], [null, 'nullversion']];
    for (const [v, label] of badVers) {
      const p = path.join(__dirname, `restore_bad_${label}.json`);
      const d = JSON.parse(fs.readFileSync(v1Path, 'utf8'));
      d.version = v;
      fs.writeFileSync(p, JSON.stringify(d));
      await page.setInputFiles('#restore-file', p);
      await expectError(page, '対応していません', `${label}を復元開始前に拒否`);
    }

    // 不正なversion2 → グループを作る前に中止
    const badV2Path = path.join(__dirname, 'restore_badv2.json');
    fs.writeFileSync(badV2Path, JSON.stringify({
      app: 'narika', version: 2, group_name: '不正v2(作成されないはず)',
      members: [{ name: 'まさと' }, { name: 'みつこ' }],
      expenses: [
        { name: '1次会', date: '2026-07-20', amount: 1000, currency: 'JPY', payer: 'まさと', beneficiaries: 'まさと,みつこ', split_mode: 'percentage', split_details: [{ member: 'まさと', share_permille: 500 }, { member: 'みつこ', share_permille: 400 }] },
        { name: 'タクシー', date: '2026-07-20', amount: 2000, currency: 'JPY', payer: 'まさと', beneficiaries: 'まさと,みつこ', split_mode: 'amount', split_details: [{ member: 'まさと', amount_minor: 1500 }, { member: 'みつこ', amount_minor: 400 }] },
      ],
      rates: {},
    }));
    await page.setInputFiles('#restore-file', badV2Path);
    await page.waitForSelector('#modal-bg', { state: 'visible', timeout: 5000 });
    const badV2Msg = await page.textContent('#modal-msg');
    check('不正v2: 復元中止メッセージ', badV2Msg.includes('復元を中止しました'));
    check('不正v2: 支払い名と理由を表示', badV2Msg.includes('1次会') && badV2Msg.includes('割合の合計が100%ではありません')
      && badV2Msg.includes('タクシー') && badV2Msg.includes('負担額の合計が支払額と一致しません'), badV2Msg.replace(/\n/g, '⏎'));
    check('不正v2: グループ未作成の明記', badV2Msg.includes('グループは作成されていません'));
    await page.click('#modal-ok');
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForSelector('#p-group.show', { timeout: 15000 });
    await page.waitForTimeout(2500);
    check('拒否された復元でグループが増えていない', (await page.locator('.g-item').count()) === groupCount + 2, String(await page.locator('.g-item').count()));
    check('不正v2グループは一覧にない', !(await page.textContent('#my-groups')).includes('不正v2'));

    console.log('--- Q. 画面サイズ(30,31) ---');
    for (const [w, h] of [[375, 667], [390, 844], [430, 932]]) {
      const ctxV = await browser.newContext({ viewport: { width: w, height: h } });
      const pv = await ctxV.newPage();
      pv.on('pageerror', e => jsErrors.push(`[${w}x${h}] ` + String(e)));
      await pv.goto(BASE + '?g=' + gid);
      await pv.waitForSelector('#p-intro.show, #p-main.show', { timeout: 15000 });
      if (await pv.isVisible('#p-intro.show')) {
        await pv.click('#btn-intro-open');
        await pv.waitForSelector('#p-main.show', { timeout: 15000 });
      }
      await pv.waitForTimeout(1500);
      await pv.click('.nb[data-tab="expenses"]');
      await pv.waitForTimeout(500);
      check(`${w}x${h}: 3方式が表示される`, (await pv.locator('#split-seg .sgb').count()) === 3 && (await pv.isVisible('#split-seg')));
      await pv.click('#split-seg .sgb[data-split="percentage"]');
      await pv.waitForTimeout(300);
      await pv.fill('#split-detail [data-split-m="まさと"]', '50');
      check(`${w}x${h}: 割合入力ができる`, (await pv.inputValue('#split-detail [data-split-m="まさと"]')) === '50');
      check(`${w}x${h}: 横スクロールなし`, await pv.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await pv.screenshot({ path: path.join(__dirname, `ss_split_${w}x${h}.png`) });
      await ctxV.close();
    }
    const ctxPC = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pp = await ctxPC.newPage();
    pp.on('pageerror', e => jsErrors.push('[pc] ' + String(e)));
    await pp.goto(BASE + '?g=' + gid);
    await pp.waitForSelector('#p-intro.show, #p-main.show', { timeout: 15000 });
    if (await pp.isVisible('#p-intro.show')) {
      await pp.click('#btn-intro-open');
      await pp.waitForSelector('#p-main.show', { timeout: 15000 });
    }
    await pp.waitForTimeout(1500);
    await pp.click('.nb[data-tab="expenses"]');
    await pp.waitForTimeout(500);
    await pp.click('#split-seg .sgb[data-split="amount"]');
    await pp.waitForTimeout(300);
    check('PC1280x800: 分け方UI表示・横スクロールなし', (await pp.isVisible('#split-detail'))
      && await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    check('PC1280x800: 3ボタンが横並び', await pp.evaluate(() => {
      const btns = [...document.querySelectorAll('#split-seg .sgb')];
      return btns.every(b => b.getBoundingClientRect().top === btns[0].getBoundingClientRect().top);
    }));
    await pp.screenshot({ path: path.join(__dirname, 'ss_split_1280x800.png') });
    await ctxPC.close();

    console.log('--- R. テストグループ削除（後片付け） ---');
    await page.waitForTimeout(500);
    for (const delGid of [restoredV1Gid, restoredV2Gid, gid]) {
      if (delGid) await deleteGroupViaUi(page, delGid);
    }
    check('テストグループを削除済み', (await page.isVisible('#p-group.show')) && (await page.locator('.g-item').count()) === 0,
      String(await page.locator('.g-item').count()));

    console.log('--- S. JSエラー確認(29) ---');
    const realErrors = jsErrors.filter(e => !e.includes('favicon'));
    check('JavaScriptエラーなし', realErrors.length === 0, realErrors.join(' | '));
  } catch (err) {
    fail++;
    console.log('TEST EXCEPTION:', err);
    try { await page.screenshot({ path: path.join(__dirname, 'ss_split_error.png') }); } catch (e) { }
    // 例外時も後片付けを試みる
    try {
      for (const delGid of [restoredV1Gid, restoredV2Gid, gid]) {
        if (delGid) await deleteGroupViaUi(page, delGid);
      }
    } catch (e) { console.log('cleanup失敗:', e.message); }
  } finally {
    await browser.close();
    server.close();
    console.log(`\n===== RESULT: ${pass} PASS / ${fail} FAIL =====`);
    process.exit(fail ? 1 : 0);
  }
})();

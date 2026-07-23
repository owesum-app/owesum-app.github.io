// narika/OweSum E2Eテスト（Playwright / Chromium）— スマホトップ3操作メニュー＋下部重複整理版
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('C:\\Users\\narim\\trip-planner\\node_modules\\playwright');

const ROOT = 'C:\\Users\\narim\\narika';
const PORT = 8123;
const BASE = `http://localhost:${PORT}/index.html`;
const GNAME = 'OweSum動作テスト(自動・削除予定)';
// 写真内の手＋スマホ本体の左端（画像幅に対する比率・実測）。パネル右端はこれより左に収める
const PHONE_LEFT_RATIO = 0.46;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

async function clickModalOk(page) { await page.click('#modal-ok'); }

async function waitToast(page, text) {
  try {
    await page.waitForSelector(`#toast-wrap .toast:has-text("${text}")`, { timeout: 5000 });
    return true;
  } catch (e) { return false; }
}

// パネルと写真内スマホの重なり判定（object-position 0% 前提で画面上のスマホ左端を計算）
async function overlapInfo(p) {
  return await p.evaluate((ratio) => {
    const img = document.querySelector('.hero-img');
    const hero = document.querySelector('.hero').getBoundingClientRect();
    const panel = document.querySelector('.hero-inner').getBoundingClientRect();
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const scale = Math.max(hero.width / nw, hero.height / nh);
    return {
      loaded: img.complete && nw > 0,
      panelLeft: Math.round(panel.left), panelRight: Math.round(panel.right),
      panelBottom: Math.round(panel.bottom),
      phoneLeft: Math.round(ratio * nw * scale),
      heroH: Math.round(hero.height),
    };
  }, PHONE_LEFT_RATIO);
}

(async () => {
  // 静的サーバ
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

  let sbRequests = 0;
  page.on('request', r => { if (r.url().includes('supabase.co')) sbRequests++; });

  try {
    console.log('--- 1. 初期表示 ---');
    await page.goto(BASE);
    await page.waitForSelector('#btn-hero-create', { timeout: 15000 });
    await page.waitForTimeout(2500);
    check('トップ画面が表示される', await page.isVisible('#p-group'));
    check('復元リンク文言が新表記', (await page.textContent('#btn-restore-sp')).includes('バックアップファイルから復元する'));
    check('トップ画面にJSON表記なし', !(await page.textContent('#p-group')).includes('JSON'));
    check('グループ名placeholder', (await page.getAttribute('#gname', 'placeholder')) === '例：歓迎会');
    check('支払い内容placeholder', (await page.getAttribute('#inp-ename', 'placeholder')) === '例：1次会 イタリアン');
    check('トップ画面にナリカ表記なし', !(await page.textContent('#p-group')).includes('ナリカ'));

    console.log('--- 1a. スマホの新トップ構成：画像→主ボタン→一覧→（下部に）復元リンク ---');
    // 廃止した旧導線（一覧へ遷移するリンク・ヒーロー内の復元副ボタン）は存在しない
    check('「参加中のグループを見る」リンクが廃止されている', (await page.locator('#btn-hero-more').count()) === 0);
    check('ヒーロー内の復元副ボタンが廃止されている', (await page.locator('#btn-hero-restore').count()) === 0);
    // 主ボタン
    check('主ボタン「新しいグループを作る」が主ボタン(.btn/.hero-btn)として表示', await page.isVisible('#btn-hero-create')
      && (await page.textContent('#btn-hero-create')).includes('新しいグループを作る'));
    check('主ボタンはオレンジの主ボタン', await page.evaluate(() => getComputedStyle(document.getElementById('btn-hero-create')).backgroundColor === 'rgb(207, 106, 31)'));
    // 一覧はトップに直接表示（別ページ・別スクロールを経由しない）
    check('参加中のグループ一覧がトップに直接表示', await page.isVisible('#my-groups'));
    check('一覧に「参加中のグループ」見出し', (await page.textContent('#my-groups')).includes('参加中のグループ'));
    // 0件時はコンパクト表示（長い説明文を出さない）
    check('0件時はコンパクトに「参加中のグループはありません」', (await page.textContent('#my-groups')).includes('参加中のグループはありません'));
    check('0件時に長い誘導文を出さない', !(await page.textContent('#my-groups')).includes('招待リンクを開くと'));
    // 復元は一覧の下の小さなテキストリンク
    check('復元は小さなテキストリンク(#btn-restore-sp)として表示', await page.isVisible('#btn-restore-sp'));
    check('復元リンクは主ボタンではない（下線付きの控えめなテキスト）', await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('btn-restore-sp'));
      return cs.textDecorationLine.includes('underline') && parseFloat(cs.fontSize) <= 14
        && (cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent');
    }));
    // 下部の大きな作成フォーム・復元カードはスマホでは非表示（DOMは残す）
    check('スマホでは下部の大きな作成フォームが非表示', !(await page.isVisible('#btn-create-group')) && !(await page.isVisible('#gname')));
    check('スマホでは下部の大きな復元カードが非表示', !(await page.isVisible('#btn-restore')));
    check('DOM自体は残っている（機能・テスト互換）', (await page.locator('#gname').count()) === 1 && (await page.locator('#btn-restore').count()) === 1 && (await page.locator('#restore-file').count()) === 1);

    console.log('--- 1a-2. 縦の並び順（画像→主ボタン→一覧→復元リンク） ---');
    const order = await page.evaluate(() => {
      const y = sel => document.querySelector(sel).getBoundingClientRect().top;
      const b = sel => document.querySelector(sel).getBoundingClientRect().bottom;
      return {
        imgBottom: b('.hero-img'), createTop: y('#btn-hero-create'), createBottom: b('#btn-hero-create'),
        groupsTop: y('#my-groups'), restoreTop: y('#restore-sp-wrap'),
      };
    });
    check('画像は主ボタンより上', order.imgBottom <= order.createTop + 2, JSON.stringify(order));
    check('主ボタンは一覧より上', order.createBottom <= order.groupsTop + 2, JSON.stringify(order));
    check('一覧は復元リンクより上', order.groupsTop <= order.restoreTop + 2, JSON.stringify(order));

    console.log('--- 1b. ヒーロー画像（モバイル幅375×720） ---');
    check('ヒーロー表示', await page.isVisible('.hero'));
    check('画像が表示される', await page.isVisible('.hero-img'));
    check('モバイル幅でmobile画像', (await page.evaluate(() => document.querySelector('.hero-img').currentSrc)).includes('owesum-hero-mobile.webp'));
    check('画像は1画面を占有しない（高さ<=画面の約半分）', await page.evaluate(() => {
      const r = document.querySelector('.hero-img').getBoundingClientRect();
      return r.height <= window.innerHeight * 0.55 + 1;
    }));
    check('画像は自然な比率のまま（左右クロップなし）', await page.evaluate(() => {
      const img = document.querySelector('.hero-img');
      const r = img.getBoundingClientRect();
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      const displayedRatio = r.width / r.height;
      return img.naturalWidth > 0 && Math.abs(naturalRatio - displayedRatio) < 0.02 && r.width <= document.documentElement.clientWidth + 1;
    }));

    console.log('--- 1b-2. 最初の1画面で画像・主ボタン・見出し・先頭項目が見える ---');
    check('画像・主ボタン・一覧見出し・0件メッセージが初期画面内(スクロール無し)', await page.evaluate(() => {
      const vh = window.innerHeight;
      const within = el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= vh + 1; };
      const img = document.querySelector('.hero-img');
      const create = document.getElementById('btn-hero-create');
      const sec = document.querySelector('#my-groups .sec');
      const card = document.querySelector('#my-groups .card');
      return window.scrollY === 0 && within(img) && within(create) && within(sec) && within(card);
    }));

    console.log('--- 1c. 作成モーダル ---');
    await page.click('#btn-hero-create');
    await page.waitForTimeout(400);
    check('モーダルが開く', await page.isVisible('#create-bg'));
    check('入力欄に自動フォーカス', (await page.evaluate(() => document.activeElement.id)) === 'gname-modal');
    await page.click('#create-cancel');
    check('キャンセルで閉じる', !(await page.isVisible('#create-bg')));
    await page.click('#btn-hero-create');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    check('Escで閉じる', !(await page.isVisible('#create-bg')));
    await page.click('#btn-hero-create');
    await page.waitForTimeout(400);
    await page.mouse.click(360, 690); // 背景タップ
    await page.waitForTimeout(200);
    check('背景タップで閉じる', !(await page.isVisible('#create-bg')));

    console.log('--- 1d. トップ下部の「バックアップファイルから復元する」リンク ---');
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
      page.click('#btn-restore-sp'),
    ]);
    check('復元リンクでファイル選択が直接開く', !!fc);
    check('開くのは既存の#restore-file input', !!fc && (await fc.element().evaluate(el => el.id)) === 'restore-file');
    check('選択キャンセルでもエラー・ダイアログなし', jsErrors.length === 0 && !(await page.isVisible('#modal-bg')));
    check('restore-file inputは1つだけ（ID重複なし）', (await page.locator('#restore-file').count()) === 1 && (await page.locator('input[type="file"]').count()) === 1);

    console.log('--- 2. グループ作成（モーダル経由） → URLに?g=が付く ---');
    await page.click('#btn-hero-create');
    await page.waitForTimeout(400);
    await page.fill('#gname-modal', GNAME);
    // 二重クリックしても1回しか登録されないこと（後の一覧件数で検証）
    await page.evaluate(() => { const b = document.getElementById('create-ok'); b.click(); b.click(); });
    await page.waitForSelector('#p-main.show', { timeout: 15000 });
    await page.waitForTimeout(1500);
    const url1 = page.url();
    check('作成後URLに?g=がある', /\?g=/.test(url1), url1);
    check('グループ名表示', (await page.textContent('#g-title')) === GNAME);
    const gid = new URL(url1).searchParams.get('g');
    check('リンク表示欄にURLが出る', (await page.textContent('#group-link-url')).includes('?g=' + gid));
    const seenAfterCreate = await page.evaluate(() => localStorage.getItem('narika_intro_seen_gids'));
    check('作成者は紹介済み扱い', seenAfterCreate && JSON.parse(seenAfterCreate).includes(gid), seenAfterCreate);

    console.log('--- 3. メンバー追加 ---');
    for (const n of ['まさと', 'みつこ']) {
      await page.fill('#inp-member', n);
      await page.click('#btn-add-member');
      await page.waitForTimeout(1200);
    }
    check('メンバー2人表示', (await page.textContent('#member-list')).includes('みつこ'));

    console.log('--- 4. リンクコピー ---');
    check('URL表示が全文（origin+path+?g=）', (await page.textContent('#group-link-url')) === `http://localhost:${PORT}/index.html?g=${gid}`);
    check('375px幅で横スクロールなし', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.click('#btn-copy-link');
    check('コピー成功トースト', await waitToast(page, 'リンクをコピーしました'));
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check('クリップボード内容が?g=付きURL', clip.includes('?g=' + gid), clip);

    console.log('--- 4b. リンク共有フォールバック(PC) / 記録共有 / PC向け保存案内 ---');
    check('PC向け保存案内', (await page.textContent('#backup-guide')).includes('ダウンロードフォルダ'));
    await page.click('#btn-share-link');
    check('招待リンクコピー＋メール起動トースト', await waitToast(page, '招待リンクをコピーしました（メールアプリも起動します）'));
    const clipShare = await page.evaluate(() => navigator.clipboard.readText());
    check('共有フォールバック内容に?g=とグループ名', clipShare.includes('?g=' + gid) && clipShare.includes(GNAME));

    console.log('--- 4c. 招待URL・メール件名の生成ロジック ---');
    const inviteFns = await page.evaluate((gid) => {
      const url = buildInviteUrl(gid);
      return {
        url,
        subject: buildInviteSubject('歓迎会'),
        noNameSubject: buildInviteSubject(''),
        mailto: buildInviteMailto('歓迎会', url),
        msg: buildInviteMessage('歓迎会', url),
      };
    }, gid);
    check('招待URLに?g=とグループIDが含まれる', inviteFns.url.includes('?g=' + gid), inviteFns.url);
    check('招待URLはlocation.origin基準（localhost固定文字列でない）', inviteFns.url.startsWith(`http://localhost:${PORT}`), inviteFns.url);
    check('件名は「OweSum「グループ名」への招待」形式', inviteFns.subject === 'OweSum「歓迎会」への招待', inviteFns.subject);
    check('グループ名なしでも件名は「OweSumへの招待」', inviteFns.noNameSubject === 'OweSumへの招待', inviteFns.noNameSubject);
    check('mailtoにsubjectパラメータが正しくエンコードされる', inviteFns.mailto.includes('subject=' + encodeURIComponent(inviteFns.subject)), inviteFns.mailto);
    check('mailto本文(body)に招待URLがエンコードされて含まれる', inviteFns.mailto.includes(encodeURIComponent(inviteFns.url)), inviteFns.mailto);
    check('共有テキスト本文にも招待URLが直接埋め込まれている（url項目だけに頼らない）', inviteFns.msg.includes(inviteFns.url), inviteFns.msg);
    check('リンクコピーと共有シェアで完全に同一の招待URL', clip.trim() === inviteFns.url, `copy=${clip} / share=${inviteFns.url}`);

    // 日本語・記号・絵文字・空白を含むグループ名でも件名・本文・URLエンコードが壊れないこと
    const trickyNames = ['旅行 2026🎉', '会議/報告 共有', '「特殊」文字テスト'];
    for (const name of trickyNames) {
      const r = await page.evaluate(({ n, gid }) => {
        const url = buildInviteUrl(gid);
        return { subject: buildInviteSubject(n), mailto: buildInviteMailto(n, url), msg: buildInviteMessage(n, url), url };
      }, { n: name, gid });
      check(`グループ名「${name}」でも件名が正しく組み立つ`, r.subject === `OweSum「${name}」への招待`, r.subject);
      check(`グループ名「${name}」でもmailtoの形式が壊れない`, r.mailto.startsWith('mailto:?subject=') && r.mailto.includes('&body='), r.mailto);
      check(`グループ名「${name}」でも本文に正しいグループの招待URLが残る`, r.msg.includes(r.url) && r.url.includes('?g=' + gid), r.msg);
    }

    await page.click('#btn-share');
    await page.waitForSelector('#modal-bg', { state: 'visible' });
    check('記録コピー案内ダイアログ', (await page.textContent('#modal-msg')).includes('記録をコピーしました'));
    await clickModalOk(page);
    const clipRec = await page.evaluate(() => navigator.clipboard.readText());
    check('記録テキストにグループ名', clipRec.includes(GNAME) && clipRec.includes('割り勘記録'));

    console.log('--- 4d. 「参加者」表記・頭文字の丸の廃止 ---');
    check('メンバー一覧に頭文字の丸(.av)が無い', (await page.locator('#member-list .av').count()) === 0);
    check('メンバー一覧は名前のみ表示', (await page.textContent('#member-list')).includes('まさと') && (await page.locator('#member-list .av').count()) === 0);
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(400);
    check('支払い登録画面のラベルが「参加者」', (await page.textContent('#t-expenses')).includes('参加者'));
    check('支払い登録画面に「受益者」表記が無い', !(await page.textContent('#t-expenses')).includes('受益者'));
    check('参加者チップに頭文字の丸(.av)が無い', (await page.locator('#ben-chips .av').count()) === 0);
    check('参加者チップは名前のみ表示', await page.evaluate(() => {
      const chips = [...document.querySelectorAll('#ben-chips .chip')];
      return chips.length >= 2 && chips.every(c => c.querySelector('.av') === null) && chips[0].textContent.trim().length > 0;
    }));
    check('選択中チップは選択状態が明確（on色＋チェックマーク疑似要素）', await page.evaluate(() => {
      const on = document.querySelector('#ben-chips .chip.on');
      if (!on) return false;
      const cs = getComputedStyle(on);
      const before = getComputedStyle(on, '::before').content;
      return cs.backgroundColor !== 'rgb(245, 245, 245)' && before && before !== 'none' && before !== 'normal';
    }));
    // チップを外すと選択状態(on)が消える＝選択が名前だけでも区別できる
    await page.click('#ben-chips .chip:first-child');
    await page.waitForTimeout(150);
    check('チップ解除で未選択状態に変わる（背景/チェックが消える）', await page.evaluate(() => {
      const first = document.querySelector('#ben-chips .chip:first-child');
      const isOff = !first.classList.contains('on');
      const before = getComputedStyle(first, '::before').content;
      return isOff && (before === 'none' || before === 'normal' || before === '');
    }));
    await page.click('#ben-chips .chip:first-child');
    await page.waitForTimeout(150);
    // 割合入力画面でも頭文字の丸が無い
    await page.click('#split-seg .sgb[data-split="percentage"]');
    await page.waitForTimeout(300);
    check('割合入力欄にも頭文字の丸(.av)が無い', (await page.locator('#split-detail .av').count()) === 0);
    await page.click('#split-seg .sgb[data-split="equal"]');
    await page.waitForTimeout(200);

    console.log('--- 5. 支払いタブ：通貨検索モーダル ---');
    await page.click('#inp-ecur-btn');
    check('通貨モーダルが開く', await page.isVisible('#cur-bg'));
    check('よく使われる通貨セクションあり', (await page.textContent('#cur-list')).includes('よく使われる通貨'));
    await page.fill('#cur-search', '香港');
    await page.waitForTimeout(200);
    let listTxt = await page.textContent('#cur-list');
    check('日本語検索でHKDが出る', listTxt.includes('HKD'));
    await page.fill('#cur-search', 'taiwan');
    await page.waitForTimeout(200);
    listTxt = await page.textContent('#cur-list');
    check('英語(小文字)検索でTWDが出る', listTxt.includes('TWD') && !listTxt.includes('USD'));
    await page.fill('#cur-search', 'hkd');
    await page.waitForTimeout(200);
    await page.click('#cur-list [data-cur="HKD"]');
    check('選択後モーダルが閉じる', !(await page.isVisible('#cur-bg')));
    check('通貨ボタン表示がHKD', (await page.textContent('#inp-ecur-label')).includes('HKD'));

    console.log('--- 6. 全角金額入力の正規化 ---');
    await page.fill('#inp-eamt', '');
    await page.type('#inp-eamt', '１，２３４．５');
    check('全角→半角/カンマ除去', (await page.inputValue('#inp-eamt')) === '1234.5', await page.inputValue('#inp-eamt'));

    console.log('--- 7. 支払い登録 → トースト ---');
    await page.fill('#inp-ename', '雲璟ディナー');
    await page.click('#btn-add-expense');
    check('登録成功トースト', await waitToast(page, '支払いを登録しました'));
    await page.waitForTimeout(1500);
    const cardTxt = await page.textContent('#exp-list');
    check('カードに支払った人ラベル', cardTxt.includes('支払った人'));
    check('カードに負担する人ラベル', cardTxt.includes('負担する人'));
    check('全員バッジ', (await page.locator('.exp-all-badge').count()) > 0);
    check('為替待ち表示', cardTxt.includes('為替レート入力待ち'));
    check('金額表示', cardTxt.includes('1,234.5'));

    console.log('--- 8. 最近使った通貨 ---');
    const recent = await page.evaluate(() => localStorage.getItem('narika_recent_curr'));
    check('localStorageにHKD保存', recent && JSON.parse(recent)[0] === 'HKD', recent);
    await page.click('#inp-ecur-btn');
    check('最近使った通貨セクション表示', (await page.textContent('#cur-list')).includes('最近使った通貨'));
    await page.keyboard.press('Escape');
    check('Escでモーダルが閉じる', !(await page.isVisible('#cur-bg')));

    console.log('--- 9. リロードで同じグループが開く ---');
    await page.reload();
    await page.waitForSelector('#p-main.show', { timeout: 15000 });
    await page.waitForTimeout(2000);
    check('リロード後も?g=保持', page.url().includes('?g=' + gid));
    check('リロード後同じグループ', (await page.textContent('#g-title')) === GNAME);

    console.log('--- 10. 一覧へ戻る → ?g=が消える / 戻る・進む ---');
    await page.click('#btn-back');
    await page.waitForTimeout(1500);
    check('一覧に戻ると?g=が消える', !page.url().includes('?g='), page.url());
    check('一覧画面表示', await page.isVisible('#p-group.show'));
    check('グループが1件のみ（二重登録なし）', (await page.locator('.g-item').count()) === 1);
    check('下部の既存作成フォームもDOMに存在', (await page.locator('#gname').count()) === 1 && (await page.locator('#btn-create-group').count()) === 1);
    check('下部の復元カードもDOMに存在', (await page.locator('#btn-restore').count()) === 1);
    check('スマホでは下部フォーム・復元カードは非表示のまま', !(await page.isVisible('#btn-create-group')) && !(await page.isVisible('#btn-restore')));
    await page.goBack();
    await page.waitForTimeout(2500);
    check('ブラウザ戻るでグループ再表示', page.url().includes('?g=') && (await page.isVisible('#p-main.show')));
    await page.goForward();
    await page.waitForTimeout(1500);
    check('ブラウザ進むで一覧表示', !page.url().includes('?g=') && (await page.isVisible('#p-group.show')));
    await page.click(`.g-item[data-id="${gid}"]`);
    await page.waitForSelector('#p-main.show', { timeout: 15000 });
    await page.waitForTimeout(1500);
    check('一覧から開いてもURLに?g=', page.url().includes('?g=' + gid));

    console.log('--- 11. 為替入力 → 円換算表示 ---');
    await page.click('.nb[data-tab="rates"]');
    await page.waitForTimeout(500);
    await page.fill('#rate-list [data-rc="HKD"]', '19.5');
    await page.dispatchEvent('#rate-list [data-rc="HKD"]', 'change');
    await page.waitForTimeout(1500);
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(500);
    check('円換算表示', (await page.textContent('#exp-list')).includes('円換算'));

    console.log('--- 12. 支払い編集 ---');
    await page.click('#exp-list [data-edit]');
    await page.waitForTimeout(300);
    check('編集ダイアログ表示', await page.isVisible('#edit-bg'));
    check('編集画面のラベルが「参加者」', (await page.textContent('#edit-bg')).includes('参加者') && !(await page.textContent('#edit-bg')).includes('受益者'));
    check('編集画面の参加者チップに頭文字の丸(.av)が無い', (await page.locator('#ed-chips .av').count()) === 0);
    check('編集の通貨表示HKD', (await page.textContent('#ed-cur-label')).includes('HKD'));
    await page.fill('#ed-amt', '');
    await page.type('#ed-amt', '６８０');
    check('編集画面でも全角→半角', (await page.inputValue('#ed-amt')) === '680');
    await page.click('#ed-save');
    check('編集保存トースト', await waitToast(page, '支払いを保存しました'));
    await page.waitForTimeout(1500);
    check('編集後の金額反映', (await page.textContent('#exp-list')).includes('680'));

    console.log('--- 13. JSONバックアップ（DLフォールバック）と復元 ---');
    await page.click('.nb[data-tab="members"]');
    await page.waitForTimeout(300);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }),
      page.click('#btn-backup-json'),
    ]);
    check('PCでは確認ダイアログなしでDL開始', !(await page.isVisible('#modal-bg')));
    check('バックアップDLトースト', await waitToast(page, 'バックアップファイルをダウンロードしました'));
    const dlPath = await download.path();
    const dlName = download.suggestedFilename();
    check('ファイル名に不正文字なし', !/[\\\/:*?"<>|]/.test(dlName), dlName);
    const backup = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
    check('JSON形式(app=narika, version=2)', backup.app === 'narika' && backup.version === 2);
    check('JSONにメンバー・支払い・レート', backup.members.length === 2 && backup.expenses.length === 1 && backup.rates.HKD == 19.5, JSON.stringify(backup).slice(0, 200));

    // 復元テスト（ヒーローの副ボタンと同じ#restore-file inputへ投入）
    await page.click('#btn-back');
    await page.waitForTimeout(1500);
    const restorePath = path.join(__dirname, 'restore_test.json');
    fs.writeFileSync(restorePath, JSON.stringify(backup));
    await page.setInputFiles('#restore-file', restorePath);
    await page.waitForSelector('#modal-bg', { state: 'visible', timeout: 5000 });
    await clickModalOk(page); // 復元します確認
    await page.waitForTimeout(3000);
    await clickModalOk(page); // 復元しました
    await page.waitForSelector('#p-main.show', { timeout: 15000 });
    await page.waitForTimeout(2000);
    const restoredGid = new URL(page.url()).searchParams.get('g');
    check('復元後グループが開き?g=付き', !!restoredGid && restoredGid !== gid);
    await page.click('.nb[data-tab="expenses"]');
    await page.waitForTimeout(1000);
    check('復元データに支払いあり', (await page.textContent('#exp-list')).includes('雲璟ディナー'));

    console.log('--- 14. 支払い削除 ---');
    await page.click('#exp-list .btn-red[data-eid]');
    await page.waitForSelector('#modal-bg', { state: 'visible' });
    await clickModalOk(page);
    check('削除トースト', await waitToast(page, '支払いを削除しました'));

    console.log('--- 14b. モバイルUA: 保存案内・確認ダイアログ・Web Share ---');
    const ctxM = await browser.newContext({
      viewport: { width: 375, height: 720 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    await ctxM.addInitScript(() => {
      window.__shareCalls = [];
      navigator.share = (data) => { window.__shareCalls.push({ title: data.title, url: data.url, files: (data.files || []).length }); return Promise.resolve(); };
      navigator.canShare = () => true;
    });
    const pm = await ctxM.newPage();
    pm.on('pageerror', e => jsErrors.push('[mobile] ' + String(e)));

    console.log('--- 14b-1. 初回紹介画面 ---');
    await pm.goto(BASE + '?g=' + gid);
    await pm.waitForSelector('#p-intro.show', { timeout: 15000 });
    await pm.waitForTimeout(1000);
    check('初回は紹介画面が表示される', await pm.isVisible('#p-intro'));
    check('紹介画面にOweSum表記', (await pm.textContent('#p-intro')).includes('OweSum') && (await pm.textContent('#p-intro')).includes('オーサム'));
    check('説明文表示', (await pm.textContent('#p-intro')).includes('みんなの立替を、かんたん割り勘'));
    check('招待グループ名表示', (await pm.textContent('#intro-gname')) === GNAME);
    check('紹介画面でも?g=維持', pm.url().includes('?g=' + gid));
    check('URLを開いただけでは確認済みにならない', !(await pm.evaluate(() => (localStorage.getItem('narika_intro_seen_gids') || '[]'))).includes(gid));
    await pm.reload();
    await pm.waitForSelector('#p-intro.show', { timeout: 15000 });
    check('未確認のままなら再読込でも紹介画面', await pm.isVisible('#p-intro'));
    await pm.click('#btn-intro-open');
    await pm.waitForSelector('#p-main.show', { timeout: 15000 });
    await pm.waitForTimeout(1500);
    check('「グループを開く」でメンバー画面へ', (await pm.textContent('#g-title')) === GNAME);
    check('遷移後も?g=維持', pm.url().includes('?g=' + gid));
    const seenM = await pm.evaluate(() => localStorage.getItem('narika_intro_seen_gids'));
    check('確認済みIDが保存される', seenM && JSON.parse(seenM).includes(gid), seenM);
    await pm.reload();
    await pm.waitForSelector('#p-main.show', { timeout: 15000 });
    await pm.waitForTimeout(1000);
    check('2回目以降は直接メンバー画面', !(await pm.isVisible('#p-intro')) && (await pm.textContent('#g-title')) === GNAME);
    await pm.goto(BASE + '?g=' + restoredGid);
    await pm.waitForSelector('#p-intro.show', { timeout: 15000 });
    check('別グループでは紹介画面が出る', await pm.isVisible('#p-intro'));
    await pm.goBack();
    await pm.waitForSelector('#p-main.show', { timeout: 15000 });
    await pm.waitForTimeout(1000);
    check('戻る後もURLと画面が一致', pm.url().includes('?g=' + gid) && (await pm.textContent('#g-title')) === GNAME);
    await pm.evaluate(() => localStorage.removeItem('narika_intro_seen_gids'));
    await pm.goto(BASE + '?g=' + gid);
    await pm.waitForSelector('#p-intro.show', { timeout: 15000 });
    check('紹介済みキー削除で再表示', await pm.isVisible('#p-intro'));
    await pm.click('#btn-intro-open');
    await pm.waitForSelector('#p-main.show', { timeout: 15000 });
    await pm.waitForTimeout(1500);

    console.log('--- 14b-2. モバイル保存案内・Web Share ---');
    check('モバイル: iOS向け保存案内が常時表示', (await pm.textContent('#backup-guide')).includes('ファイルに保存'));
    await pm.click('#btn-backup-json');
    await pm.waitForSelector('#modal-bg', { state: 'visible' });
    check('保存前確認ダイアログ(iOS文言)', (await pm.textContent('#modal-msg')).includes('ファイルに保存'));
    check('OKボタンが「保存を続ける」', (await pm.textContent('#modal-ok')).trim() === '保存を続ける');
    await pm.click('#modal-cancel');
    await pm.waitForTimeout(500);
    check('キャンセルで保存処理が開始されない', (await pm.evaluate(() => window.__shareCalls.length)) === 0);
    await pm.click('#btn-backup-json');
    await pm.waitForSelector('#modal-bg', { state: 'visible' });
    await pm.click('#modal-ok');
    check('準備トースト', await waitToast(pm, 'バックアップファイルを準備しました'));
    const shareCalls = await pm.evaluate(() => window.__shareCalls);
    check('Web Shareにファイルが渡る', shareCalls.length === 1 && shareCalls[0].files === 1, JSON.stringify(shareCalls));
    await pm.click('#btn-share-link');
    await pm.waitForTimeout(500);
    const shareCalls2 = await pm.evaluate(() => window.__shareCalls);
    check('リンク共有がWeb Shareを呼びURLに?g=', shareCalls2.length === 2 && String(shareCalls2[1].url).includes('?g=' + gid), JSON.stringify(shareCalls2));
    check('共有タイトルにグループ名', String(shareCalls2[1].title).includes(GNAME));
    await pm.click('#btn-del-group');
    await pm.waitForSelector('#modal-bg', { state: 'visible' });
    check('OKラベルがリセットされる', (await pm.textContent('#modal-ok')).trim() === 'OK');
    await pm.click('#modal-cancel');
    await ctxM.close();

    console.log('--- 15. viewport別 スマホトップ構成＋スクリーンショット ---');
    for (const [w, h] of [[375, 667], [375, 720], [390, 844], [430, 932]]) {
      const ctxV = await browser.newContext({ viewport: { width: w, height: h } });
      const pv = await ctxV.newPage();
      pv.on('pageerror', e => jsErrors.push(`[${w}x${h}] ` + String(e)));
      await pv.goto(BASE);
      await pv.waitForSelector('#btn-hero-create', { timeout: 15000 });
      await pv.waitForTimeout(1500);
      const layout = await pv.evaluate(() => {
        const img = document.querySelector('.hero-img');
        const r = img.getBoundingClientRect();
        const naturalRatio = img.naturalWidth / img.naturalHeight;
        const displayedRatio = r.width / r.height;
        const vh = window.innerHeight;
        const within = sel => { const b = document.querySelector(sel).getBoundingClientRect(); return b.top >= 0 && b.bottom <= vh + 1; };
        const y = sel => document.querySelector(sel).getBoundingClientRect().top;
        const b = sel => document.querySelector(sel).getBoundingClientRect().bottom;
        return {
          imgLoaded: img.naturalWidth > 0, imgWidth: Math.round(r.width), clientWidth: document.documentElement.clientWidth,
          ratioMatch: Math.abs(naturalRatio - displayedRatio) < 0.02,
          createH: Math.round(document.getElementById('btn-hero-create').getBoundingClientRect().height),
          firstScreen: window.scrollY === 0 && within('.hero-img') && within('#btn-hero-create') && within('#my-groups .sec') && within('#my-groups .card'),
          order: b('.hero-img') <= y('#btn-hero-create') + 2 && b('#btn-hero-create') <= y('#my-groups') + 2 && y('#my-groups') <= y('#restore-sp-wrap') + 2,
          avCount: document.querySelectorAll('#p-group .av').length,
        };
      });
      check(`${w}x${h}: 画像ロード済み・左右クロップなし`, layout.imgLoaded && layout.ratioMatch && layout.imgWidth <= layout.clientWidth + 1, JSON.stringify(layout));
      check(`${w}x${h}: 主ボタン高さ44px以上`, layout.createH >= 44, String(layout.createH));
      check(`${w}x${h}: 画像→主ボタン→一覧→復元リンクの縦並び`, layout.order, JSON.stringify(layout));
      check(`${w}x${h}: 画像・主ボタン・見出し・先頭項目が初期画面内(スクロール無し)`, layout.firstScreen, JSON.stringify(layout));
      check(`${w}x${h}: 廃止した一覧リンク・復元副ボタンは無い`, (await pv.locator('#btn-hero-more').count()) === 0 && (await pv.locator('#btn-hero-restore').count()) === 0);
      check(`${w}x${h}: 下部の大きな作成フォーム・復元カード非表示`, !(await pv.isVisible('#btn-create-group')) && !(await pv.isVisible('#btn-restore')));
      check(`${w}x${h}: 一覧・復元リンク表示`, (await pv.isVisible('#my-groups')) && (await pv.isVisible('#btn-restore-sp')));
      check(`${w}x${h}: 頭文字の丸(.av)がトップに無い`, layout.avCount === 0, String(layout.avCount));
      check(`${w}x${h}: 横スクロールなし`, await pv.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
      await pv.screenshot({ path: path.join(__dirname, `ss_hero_${w}x${h}.png`), fullPage: true });
      await ctxV.close();
    }

    console.log('--- 15b. PC幅ヒーロー / 画像読み込み失敗時 ---');
    const ctxPC = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pp = await ctxPC.newPage();
    pp.on('pageerror', e => jsErrors.push('[pc] ' + String(e)));
    await pp.goto(BASE);
    await pp.waitForSelector('#btn-hero-create', { timeout: 15000 });
    await pp.waitForTimeout(2000);
    check('PC幅でdesktop画像', (await pp.evaluate(() => document.querySelector('.hero-img').currentSrc)).includes('owesum-hero-desktop.webp'));
    check('PCでヒーローが画面全体を覆う', await pp.evaluate(() => document.querySelector('.hero').offsetHeight >= window.innerHeight - 1));
    const ppBtn = await pp.locator('#btn-hero-create').boundingBox();
    check('PCでボタンが初期画面内', ppBtn && ppBtn.y + ppBtn.height <= 800);
    const ppTitle = await pp.locator('.hero-title').boundingBox();
    check('PCで文字ブロックが左側', ppTitle && ppTitle.x >= 1280 * 0.06 && ppTitle.x + ppTitle.width <= 1280 * 0.55, JSON.stringify(ppTitle));
    check('PCでは説明文と注記を表示', await pp.evaluate(() => getComputedStyle(document.querySelector('.hero-desc')).display !== 'none' && getComputedStyle(document.querySelector('.hero-note')).display !== 'none'));
    check('PCでは復元テキストリンク(#restore-sp-wrap)は非表示', await pp.evaluate(() => getComputedStyle(document.getElementById('restore-sp-wrap')).display === 'none'));
    check('PCでは下部の作成フォームを表示', await pp.evaluate(() => { document.getElementById('btn-create-group').scrollIntoView(); return true; }) && (await pp.isVisible('#btn-create-group')) && (await pp.isVisible('#gname')));
    check('PCでは下部の復元カードを表示', await pp.isVisible('#btn-restore'));
    await pp.evaluate(() => window.scrollTo(0, 0));
    await pp.waitForTimeout(300);
    await pp.screenshot({ path: path.join(__dirname, 'ss_hero_1280x800.png') });
    await pp.click('#btn-hero-create');
    await pp.waitForTimeout(400);
    check('PCでもボタンで作成モーダルが開く', (await pp.isVisible('#create-bg')) && (await pp.evaluate(() => document.activeElement.id)) === 'gname-modal');
    await pp.click('#create-cancel');
    await ctxPC.close();
    // 画像がロードできない場合でも見出し・ボタン・一覧・復元リンクが機能する
    const ctxNoImg = await browser.newContext({ viewport: { width: 375, height: 720 } });
    await ctxNoImg.route('**/*.webp*', r => r.abort());
    const pn = await ctxNoImg.newPage();
    await pn.goto(BASE);
    await pn.waitForSelector('#btn-hero-create', { timeout: 15000 });
    await pn.waitForTimeout(1000);
    check('画像失敗時は見出しをフォールバック表示', await pn.evaluate(() => document.querySelector('.hero').classList.contains('img-failed') && getComputedStyle(document.querySelector('.hero-title')).display !== 'none'));
    check('画像失敗時も主ボタン・一覧・復元リンク表示', (await pn.isVisible('#btn-hero-create')) && (await pn.isVisible('#my-groups')) && (await pn.isVisible('#btn-restore-sp')));
    await pn.screenshot({ path: path.join(__dirname, 'ss_hero_imgfail_375x720.png'), fullPage: true });
    await pn.click('#btn-hero-create');
    await pn.waitForTimeout(400);
    check('画像失敗時もボタン操作可能', (await pn.isVisible('#create-bg')) && (await pn.evaluate(() => document.activeElement.id)) === 'gname-modal');
    await ctxNoImg.close();

    console.log('--- 16. テストグループ削除（後片付け） ---');
    for (const delGid of [restoredGid, gid]) {
      if (!delGid) continue;
      if (await page.isVisible('#p-main.show')) {
        await page.click('.nb[data-tab="members"]');
        await page.waitForTimeout(200);
        await page.click('#btn-back');
        await page.waitForTimeout(1500);
      }
      const sel = `.g-item[data-id="${delGid}"]`;
      if (!(await page.locator(sel).count())) continue;
      await page.click(sel);
      await page.waitForSelector('#p-main.show');
      await page.waitForTimeout(1500);
      const nm = await page.textContent('#g-title');
      await page.click('#btn-del-group');
      await page.waitForSelector('#modal-bg', { state: 'visible' });
      await clickModalOk(page); // 確認1
      await page.waitForTimeout(300);
      await page.fill('#modal-input', nm); // 名前入力
      await clickModalOk(page);
      await page.waitForTimeout(2500);
    }
    check('テストグループを削除済み', await page.isVisible('#p-group.show'));
    const remaining = await page.evaluate(() => localStorage.getItem('narika_gids'));
    console.log('  残localStorage gids:', remaining);

    console.log('--- 17. JSエラー確認 ---');
    const realErrors = jsErrors.filter(e => !e.includes('favicon'));
    check('JavaScriptエラーなし', realErrors.length === 0, realErrors.join(' | '));
    console.log('  Supabaseリクエスト総数:', sbRequests);
  } catch (err) {
    fail++;
    console.log('TEST EXCEPTION:', err);
    try { await page.screenshot({ path: path.join(__dirname, 'ss_error.png') }); } catch (e) {}
  } finally {
    await browser.close();
    server.close();
    console.log(`\n===== RESULT: ${pass} PASS / ${fail} FAIL =====`);
    process.exit(fail ? 1 : 0);
  }
})();

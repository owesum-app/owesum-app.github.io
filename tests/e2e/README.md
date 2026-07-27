# OweSum E2E tests

## owesum_jpy_golden_e2e.js

現行のJPY精算結果を固定するゴールデンテストです。

精算エンジンをJPY固定からグループ基準通貨対応へ一般化する前の安全基準として、
現在の精算仕様（個人ごとの立替額・負担額・差額、送金元・送金先・送金額、
丸め単位1円/10円/100円、為替レート不足判定、共有可否、精算共有文の全文、
画面に表示される円金額）を明示的な期待値としてテストコード内に固定しています。

基準通貨対応などエンジン変更後も本テストを実行し、既存JPYグループの結果が
1円も変わっていないことを確認する用途で使います。

実行コマンド：

```
node tests/e2e/owesum_jpy_golden_e2e.js
```

* 本番Supabaseへの通信はすべてルート横取りで遮断し、書込みは0件です（テストグループを本番に作成しません）。
* Googleへの実送信もありません（gtag.jsは空スタブ、収集リクエストは204横取り）。
* 期待値は手計算と独立実装で照合したうえでハードコードしています。
  テスト実行のたびに期待値を自動更新するスナップショット方式ではありません。
  期待値の変更は精算仕様の変更そのものを意味するため、無断で更新しないでください。

## owesum_base_currency_engine_e2e.js

精算エンジン内部の「基準通貨の最小単位」建て計算（USD・セント単位）を検証するテストです。

USD基準の均等割り・割合指定・複数通貨混在（JPY/EUR）・丸め単位（1/10/100セント）・
欠損レート判定・JPY後方互換を、テスト専用の基準通貨切替（`__setSettleState`の第6引数、
省略時は必ずJPY）経由で整数minor unitとして固定検証します。

通常の日本語版は引き続きJPY固定で動作し、利用者向けのUSD表示・基準通貨変更UIはありません。

実行コマンド：

```
node tests/e2e/owesum_base_currency_engine_e2e.js
```

* 本番Supabaseへは接続しません（全ルート横取り・書込み0件）。Googleへの実送信もありません。
* 為替レートはテスト内固定値のみで、本番レートは使用しません。
* 期待値は手計算と独立実装で照合したうえでハードコードしています。無断で更新しないでください。

## owesum_base_currency_db_e2e.js

グループ基準通貨のDB連携（`public.groups.base_currency`）を検証するテストです。

`/ja/` の新規グループ作成・復元でのINSERTに`base_currency:'JPY'`が明示されること、
グループ読込時にDB行のbase_currencyが内部エンジンへ設定されること（JPY行→JPY、
USDモック行→USDでURLの`/ja/`に上書きされない）、不正値・未知コードを黙ってJPY扱いせず
読込を安全に中止すること、base_currency欠落行は既存モック互換でJPYになることを検証します。

実行コマンド：

```
node tests/e2e/owesum_base_currency_db_e2e.js
```

* 本番Supabaseへは接続しません（全ルート横取り・本番書込み0件）。Googleへの実送信・group_created実送信もありません。
* 基準通貨は必ずDBのグループ行を正とし、URL・ブラウザ言語・localStorageでは決定しない設計を固定します。

## owesum_base_currency_backup_e2e.js

JSONバックアップ・復元の基準通貨対応（version 2/3）を検証するテストです。

JPY基準グループのバックアップは従来どおりversion 2でbase_currencyを出力しないこと、
JPY以外の基準通貨グループはversion 3でbase_currencyを必須出力すること、復元時に
version 1・2は常にJPY、version 3はbase_currency（大文字英字3文字かつ通貨一覧に存在、
legacy:true可）を検証してから復元すること、不正なbase_currency・未対応バージョン・
不正appはグループ作成前に拒否しSupabase書込み・localStorage追加を0件にすること、
ratesは基準通貨自身を除外し逆数化・換算しないこと、バックアップ→復元の往復で
支払い・rates・精算結果が一致することを確認します。

実行コマンド：

```
node tests/e2e/owesum_base_currency_backup_e2e.js
```

* 本番Supabaseへは接続しません（全ルート横取り・本番書込み0件）。Googleへの実送信もありません。
* 既存のJPYバックアップ（version 2）のJSON内容・既存E2Eの期待値は変更していません。

## owesum_field_usability_e2e.js

コミット7daa80aで修正した以下の範囲を確認する55件のテストです。

* トップ画像
* 下部タブ
* 精算単位
* 精算結果共有
* メール共有文字列
* LINE共有文字列

## owesum_en_locale_e2e.js

`ja/index.html`を基に新設した英語版`en/index.html`が、日本語版のDB・JSONバックアップ仕様
（version 1/2/3、`groups.base_currency`、精算エンジン）を一切変えずに、画面文言のみ英語で
正しく動作することを検証するテストです。

`/en/`の表示・英語文言（日本語残存なし）、新規グループ作成時の`base_currency:'USD'`明示、
新規支払いの初期通貨USD、JPY基準グループを`/en/`で開いてもJPY精算・USD基準グループを`/ja/`で
開いてもUSD精算になること、同一グループを`/ja/`と`/en/`で開いたときの送金結果一致、
言語切替リンク（`.lang-switch-link`）がグループID・精算共有URLのtab/ogv・ハッシュを維持すること、
バックアップversion 1・2・3の復元、精算結果共有・招待共有の文面が英語で構成されることを確認します。

実行コマンド：

```
node tests/e2e/owesum_en_locale_e2e.js
```

* 本番Supabaseへは接続しません（全ルート横取り・本番書込み0件）。Googleへの実送信もありません。
* `ja/index.html`側の変更は言語切替リンクの追加のみで、既存の文言・DB仕様・URL管理ロジックは変えていません。

## e2e_narika.js / e2e_split.js

OweSum全体の既存回帰テストです。

これらのテストはSupabase上でテスト用グループやデータを作成・削除する可能性があります。

実行前に、対象Supabase環境、使用するグループID、作成データ、削除処理を確認してください。
明示的な許可なしに実行しないでください。

## 注意

テストを実行する場合も、push、merge、本番公開は別途明示的な指示があるまで行わないでください。

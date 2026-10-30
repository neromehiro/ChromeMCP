# ChromeMCP

既存のChromeを、ローカルのMCPクライアントから操作するブリッジです。
Local Chrome Bridge 0.5.3 の接続・転送・セッション終了処理を独立させました。

**この公開リポジトリはMCPアダプターのソースです。単体ではブラウザ操作を開始できません。**
ブラウザ操作エンジンは外部ランタイムに依存します。外部ランタイム、拡張コア、画像、実行バイナリは同梱しません。
現状は互換ランタイムをローカルに用意できる開発者向けで、一般向けのワンコマンドインストール版ではありません。

## 構成

```text
MCP client (stdio)
  → ChromeMCP / external Node REPL MCP
  → external browser service
  → local Unix socket / Python bridge
  → WebSocket 127.0.0.1:8766
  → unpacked Chrome extension
  → Chrome debugger / CDP
```

- 既存のChromeプロファイルに拡張を読み込み、タブ・ページ操作を実行します。
- MCPの終了・リセットに合わせてセッション終了を転送します。
- 複数のChromeプロファイルが接続された場合、対象を明示して選びます。
- Chromeのリモートデバッグポートは必要ありません。
- 自作アダプターと外部エンジンの境界を維持しています。独立したブラウザエンジンではありません。

## 必要なもの

- macOS（開発・検証環境。Windowsは未対応、Linuxは未検証）
- Python 3.11以降、Node.js 22以降、Chrome 125以降
- 外部バージョン `1.26.901.11451` を使用する準備済みLocal Chrome Bridge 0.5.3
- 外部Node REPLのサンドボックス起動に必要な互換CLI。`CODEX_CLI_PATH` で指定できます。

`vendor-lock.json` が外部入力のSHA-256を固定しています。最新版アプリのファイルをそのまま代用することはできません。
外部ファイルは各利用者が利用権限のある環境で用意してください。このリポジトリからダウンロード・配布しません。

## セットアップ

```sh
git clone https://github.com/neromehiro/ChromeMCP.git
cd ChromeMCP
python3 -m venv .venv
.venv/bin/python -m pip install -e .
python3 scripts/import_runtime.py \
  --from-bridge /absolute/path/to/prepared-local-chrome-bridge \
  --node /absolute/path/to/node
```

インポーターはハッシュが一致する必要ファイルだけをコピーします。設定・ログ・ブラウザデータはコピーしません。
生成される `extension/` を、対象プロファイルの `chrome://extensions` → デベロッパーモード →「パッケージ化されていない拡張機能を読み込む」で読み込みます。
表示名は **ChromeMCP** です。既存Local Chrome Bridgeと拡張ID・既定ポートを共有するため、同じプロファイルで同時に有効化しないでください。

別ターミナルでブリッジを起動します。

```sh
.venv/bin/chromemcp serve
```

接続状況を確認します。

```sh
.venv/bin/chromemcp status
```

ソースチェックアウトからのeditable installが必要です。現状のwheelを単独配布する方式やPyPI/npm配布には対応していません。

## MCP設定

MCPクライアントの設定例（絶対パスに置き換えてください）：

```json
{
  "mcpServers": {
    "ChromeMCP": {
      "command": "/absolute/path/to/ChromeMCP/.venv/bin/chromemcp",
      "args": ["mcp", "--config-source", "local"],
      "env": {
        "CODEX_CLI_PATH": "/absolute/path/to/compatible/codex"
      }
    }
  }
}
```

`local` は設定供給元をローカルにします。既定のポリシーファイルは `.runtime/local-browser-policy.json`。
既存ホストの設定を使う場合は `--config-source codex` を指定します。CLIの既定値も `codex` です。
設定拒否・確認要求は外部ランタイムに委ね、確認への応答を自動生成しません。確認UIがないクライアントでは操作が停止することがあります。
互換コマンド名 `chrome-bridge` も残しています。

MCPの `js` ツールでブラウザクライアントを初期化する例：

```js
var { setupBrowserRuntime } = await import("file:///absolute/path/to/ChromeMCP/upstream/browser-client.mjs");
var agent = await setupBrowserRuntime();
console.log(await agent.browsers.list());
// 一覧のIDを確認して選択する
var browser = await agent.browsers.get("BROWSER_ID");
console.log(await browser.documentation());
```

ブラウザ操作前にプロファイルと対象サイトのアカウントを確認してください。
ファイル添付ではファイル選択イベントの待機を始めてからボタンをクリックし、絶対パスを渡します。

## 接続とデータ

ブリッジはループバックにのみバインドし、拡張のOriginとHostを検査します。
ローカルの `/client` 接続はOS上の利用者・プロセスを信頼します。別途ユーザー認証するネットワークサービスではありません。
拡張は `debugger`、全URLへのアクセス、タブ等の広い権限を使用します。信頼するMCPクライアントとプロファイルだけで利用してください。
画面キャプチャ・ポリシー・実行時データをGitへ追加しないでください。

## 開発・検証

外部ランタイム不要の検証：

```sh
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
node --test tests/local-config.test.js tests/transport-buffer.test.js
python3 scripts/check_publication.py
```

外部ランタイム導入後は `python3 run_js_tests.py` で追加のエンジン・アダプターテストを実行できます。
テスト成功は元アプリ全体との動作同等性を意味しません。

## 外部コードとライセンス

[THIRD_PARTY.md](THIRD_PARTY.md) を参照してください。OpenAI、Googleによる公式製品ではありません。
本リポジトリの公開は外部製品のソース・バイナリの再配布許諾を意味しません。
この公開版では独自ソースへの包括的なオープンソースライセンスもまだ付与していません。

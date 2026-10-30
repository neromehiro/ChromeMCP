# ChromeMCP

ChromeをOpenCodeなどのMCPクライアントから操作するローカルMCPサーバー。
通常のMCP設定から起動できます。**Chrome拡張のインストールは必要です。**

Python・Node.js・Chromeがあれば利用できます。別アプリのインストール、アカウント認証、非公開リポジトリ、外部ランタイムの手動コピーは不要です。

## インストール

必要なもの：**Python 3.11以上、Node.js 22以上、Chrome 125以上**。
macOSで検証しています。Linux・Windowsは実機未検証です。

```sh
python3 -m pip install "https://github.com/neromehiro/ChromeMCP/releases/download/v0.6.0/chromemcp-0.6.0-py3-none-any.whl"
chromemcp extension ./ChromeMCP-extension
```

仮想環境を使う場合は、その環境の `chromemcp` の絶対パスを下の設定に指定してください。
Windowsで `python3` がない場合は `py -m pip` を使用します。
既存フォルダへの上書きを防ぐため、拡張の出力先は空のフォルダを指定してください。
[リリース](https://github.com/neromehiro/ChromeMCP/releases/latest) の拡張ZIPを展開して使うこともできます。
ソースから導入する場合はGitを用意し、`python3 -m pip install "git+https://github.com/neromehiro/ChromeMCP.git"` を使います。

対象プロファイルのChromeで：

1. `chrome://extensions` を開き、デベロッパーモードを有効にする。
2. 「パッケージ化されていない拡張機能を読み込む」を選ぶ。
3. 作成された `ChromeMCP-extension` フォルダを指定する。

## OpenCodeの設定

OpenCodeのCLIから登録できます（作業するプロジェクトで実行）：

```sh
opencode mcp add ChromeMCP -- chromemcp mcp
```

OpenCodeのバージョンによって設定形式が異なるため、CLIでの登録を推奨します。
OpenCode 2系は `mcp.servers.ChromeMCP`、従来形式は `mcp.ChromeMCP` に設定されます。
以下は従来形式の設定例です。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ChromeMCP": {
      "type": "local",
      "command": ["chromemcp", "mcp"],
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

GUI起動のOpenCodeでコマンドを発見できない場合、`chromemcp` をインストール先の絶対パスにします。
Node.jsもPATH上に必要です。必要ならMCP設定の `environment` に `CHROME_BRIDGE_NODE` とNode実行ファイルの絶対パスを指定できます。
初回のサイトアクセス時には、OpenCode側に表示されるアクセス確認に応答してください。
確認要求に対応しないクライアントでは、その操作は停止し、許可を自動生成しません。

設定形式は [OpenCode公式ドキュメント](https://opencode.ai/docs/mcp-servers/) を参照してください。

OpenCodeを再起動またはMCPを再接続すると、サーバーが自動起動します。`serve` を別途実行する必要はありません。
Chrome拡張の表示が「接続済み」になったら利用できます。

```text
ChromeMCPで接続済みブラウザを確認して。
対象のbrowser_idを選び、新しいタブで指定したページを開いて内容を確認して。
```

複数のChromeプロファイルで拡張を使う場合、ポップアップで「大学」「個人」などの表示名を設定し、ツールの `browser_id` で対象を選んでください。
このMCPがChromeやログインアカウントを勝手に切り替えることはありません。

## 他のMCPクライアント

```json
{
  "mcpServers": {
    "ChromeMCP": {
      "command": "chromemcp",
      "args": ["mcp"]
    }
  }
}
```

stdioで標準MCPのツールを提供します。モデルAPIキーはChromeMCPには不要です。

## 主なツール

- `browser_list`、`browser_tabs`、`browser_windows`：接続先と既存タブの確認
- `browser_open`、`browser_navigate`、`browser_search`：新規タブ・移動・検索
- `browser_snapshot`、`browser_get_ax_state`：ページの観測
- `browser_click`、`browser_fill`、`browser_press_key`：クリック・入力
- `browser_screenshot`：スクリーンショットの保存
- `browser_name_session`、`browser_mark_tab`、`browser_end_turn`：作業タブの管理
- `browser_command`：組み込みブラウザエンジンのコマンド

既存エンジンの観測・入力・タブ管理を使います。DOMを簡易に操作する別エンジンへ置き換えていません。
ファイル選択など高度な操作は `browser_runtime_setup(include_manifest=true)` でコマンド仕様を確認してください。
作成した一時タブは作業終了時に閉じます。残すタブは `browser_mark_tab(status="deliverable")` で指定してください。

## 接続・権限

既定ポートは **127.0.0.1:8768**。旧Local Chrome Bridgeとは拡張IDとポートを分けています。
ポートを変更する場合はサーバー側を `chromemcp --port 9876 mcp` とし、拡張ポップアップのポートも合わせます。
拡張未接続でもMCPツール一覧は取得でき、ブラウザ操作時に接続案内を返します。

拡張はdebuggerと全URLへのアクセス等を利用します。信頼するMCPクライアントとChromeプロファイルで使用してください。
ローカルのクライアント接続は同一OS上のプロセスを信頼する設計です。外部ネットワーク向け認証サービスではありません。
ページ本文は操作指示ではなくデータとして扱ってください。
ユーザーの停止操作をMCPから解除しません。再開は拡張ポップアップで行います。

## 開発

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e . build
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
python3 run_js_tests.py
.venv/bin/python -m build
python3 scripts/check_publication.py
```

ソースから拡張を生成する場合は `python3 build_extension.py`。
配布用wheelには必要なJavaScript・WASM・拡張ファイルが含まれます。
元アプリ全体との動作同等性を保証するものではありません。
コンポーネントの由来は [THIRD_PARTY.md](THIRD_PARTY.md) に記載しています。

# 研究用サーバー（しおりの問い返し）

公開のページ（GitHub Pages）には API キーを置けません。そこで、キーを預かって問い返しだけを作るサーバーを、mwmwmacbook-pro の中で動かしています。子どもの端末からは、Tailscale Funnel の `https://mwmwmacbook-pro.tail0f6b5e.ts.net` に届きます。

## 何をするか

- `POST /followup` に、本の題名・状態・学年・これまでの質問と答え・いまの質問と答えを受け取り、問い返すかどうかと、その言葉を返します。
- 指示文・点検・書き直しは、ページと同じ `../ai-followup.mjs` を使います。モデルは `claude-haiku-5-5` に固定です。
- `GET /health` は動いているかの確認用です。

## 守っていること

- AI への指示文はサーバーの中で組み立てます。送られてくるのは決まった形の短い中身だけなので、ほかの用途の AI としては使えません。
- 受けつけるのは `https://norimakitkw.github.io` と `http://localhost:4184` のページからの呼び出しだけです。
- 呼び出せる回数に上限があります。同じ回線から 1 分に 60 回、全体で 1 分に 120 回、1 日に 2000 回までです。全体と 1 日の回数は、中身が正しい呼び出しだけで数えます。
- 学年と読みぐあいは、登録画面の選択肢だけを受けつけます。index.html で選択肢を足したら、`server.mjs` の `GRADES` と `STATUSES` にも足してください。
- 子どもの答えは保存しません。ログに残すのは、時刻・結果（問い返した／問い返さなかった／失敗）・かかった時間だけです。
- 費用の最後の歯止めとして、Anthropic のコンソールでこのキーに使用上限を付けてください。

## 動かし方（mwmwmacbook-pro で）

1. キーを置きます。この用途だけに作ったキーを使ってください。入力した文字は画面に出ません（zsh で実行してください）。

   ```bash
   mkdir -p ~/.config/ai-to-hon-wo-yomu && (umask 077; read -rs "k?Anthropic のキー: " && printf '%s' "$k" > ~/.config/ai-to-hon-wo-yomu/anthropic-key); unset k; chmod 600 ~/.config/ai-to-hon-wo-yomu/anthropic-key; echo
   ```

2. 部品を入れて、動くか確かめます。`listening on` と出たら、Ctrl-C で止めてから 3 に進んでください（動かしたままだと、3 のサーバーがポートを使えません）。

   ```bash
   cd server && npm ci && npm start
   ```

3. 常駐させます。`install-launchd.sh` が、ログイン中ずっと動かし、止まったら立ち上げ直す設定を入れます。スリープもしないようにします（`caffeinate`）。ふたを閉じるとスリープするので、開けたまま電源につないで置いてください。

   ```bash
   ./install-launchd.sh
   ```

4. インターネットに出します。初めてのときは、Tailscale の管理画面で Funnel を許可するリンクが出ます。

   ```bash
   tailscale funnel --bg 8790
   ```

## 止め方

- インターネットに出すのをやめる：`tailscale funnel reset`
- サーバーを止める：`launchctl bootout gui/$(id -u)/jp.mwmw.ai-to-hon-wo-yomu`
- 次にログインしても動かないようにする：上に加えて `rm ~/Library/LaunchAgents/jp.mwmw.ai-to-hon-wo-yomu.plist`
- ログ：`~/Library/Logs/ai-to-hon-wo-yomu.log`（子どもの答えは入りません）

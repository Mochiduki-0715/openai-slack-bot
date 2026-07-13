# OpenAI Slack bot

Slack でボットをメンションすると、OpenAI API を使ってスレッドに返信する最小構成のボットです。Google Cloud Run に配置する構成なので、PCを起動しておく必要はありません。通常はリクエストがない間、インスタンスをゼロまで縮小します。

## 1. Slack アプリを作成する

1. [Slack API](https://api.slack.com/apps) で **Create New App** → **From an app manifest** を選ぶ。
2. インストール先のワークスペースを選び、[`slack-app-manifest.yaml`](./slack-app-manifest.yaml) の内容を貼り付けて作成する。
3. **Basic Information** から Signing Secret を取得する。
4. **OAuth & Permissions** からアプリをワークスペースにインストールし、Bot User OAuth Token（`xoxb-`）を取得する。

## 2. Cloud Run に配置する

1. Google Cloud でプロジェクトと請求先を用意し、Cloud Run と Secret Manager のAPIを有効にする。
2. Secret Manager に次の3つを作る。値はCLI・Slack・Gitへ貼り付けない。

   - `openai-api-key`
   - `slack-bot-token`
   - `slack-signing-secret`

3. Cloud SDK でデプロイする。`asia-northeast1` は東京リージョンです。

```sh
cd /Users/tatsuya.mochizuki/openai-slack-bot
gcloud run deploy openai-slack-bot \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --min 0 \
  --set-secrets OPENAI_API_KEY=openai-api-key:1,SLACK_BOT_TOKEN=slack-bot-token:1,SLACK_SIGNING_SECRET=slack-signing-secret:1 \
  --set-env-vars OPENAI_MODEL=gpt-5.6-terra,ALLOWED_CHANNEL_IDS=CHANNEL_ID
```

`CHANNEL_ID` は2人で使うプライベートチャンネルのIDに置き換える。`--min 0` なら、使っていない間はインスタンスが停止する。最初の応答が少し遅い場合だけ、必要に応じて `--min 1` に変更する。

4. デプロイ完了時のサービスURLに `/slack/events` を付け、Slackアプリの **Event Subscriptions** の Request URL に設定する。
5. 同じ画面でイベントを有効化し、Bot Events に `app_mention` を追加して変更を保存する。

## ローカル動作確認（任意）

```sh
cp .env.example .env
npm install
npm run check
npm run start:local
```

通常の会話用モデルは `gpt-5.6-terra`、推論強度は `medium` です。必要なら `OPENAI_MODEL` を `gpt-5.6-sol` または `gpt-5.6-luna` に、`OPENAI_REASONING_EFFORT` を `low` / `medium` / `high` に変更できます。

最新情報・確認・リンクが必要な質問では、OpenAI APIのWeb検索を自動で利用します。検索を使った回答には情報源リンクを含めます。

Slack の許可チャンネルで、次のようにメンションしてください。

```
@gpt 今日の会議メモを3行で要約して
```

モデルを投稿ごとに指定することもできます。`sol` または `terra` をメンション直後の先頭に置きます。モデル名を省略した場合は Terra です。

```
@gpt sol この設計のリスクを詳しくレビューして
@gpt terra 今日の会議メモを3行で要約して
```

返信は元メッセージのスレッドに投稿されます。

## 次の拡張候補

- スレッドの会話履歴を API に渡して、文脈を引き継ぐ
- 利用量の通知をSlackに送る
- Cloud Runのサービスアカウントを最小権限にする

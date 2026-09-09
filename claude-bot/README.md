# Claude Slack bot

`@claude` へのメンションに、Claude Fable 5.1・最大推論で返信する独立したSlack botです。会話、Web検索、添付画像・PDFの読取りに対応します。既存の `@gpt` と同じチャンネルで使えます。

このディレクトリは専用のnpmパッケージ・Dockerイメージ・Cloud Runサービスとして動作します。Slackアプリと認証情報はClaude専用で、同じスレッドの会話履歴はGPTと共有します。

## Slackアプリと認証情報の準備

1. [Slack API](https://api.slack.com/apps) で **Create New App → From an app manifest** を選び、既存のGPT botと同じワークスペースに [`slack-app-manifest.yaml`](./slack-app-manifest.yaml) から新しいアプリを作成します。
2. **Basic Information** でSigning Secretを確認し、**OAuth & Permissions** からインストールしてBot User OAuth Tokenを取得します。アイコンには [`assets/claude-bot-icon-512.png`](./assets/claude-bot-icon-512.png) を設定します。指定された元画像も同じディレクトリに保存し、絵と文字を維持して拡大・白い余白を追加した512×512px版を用意しています。
3. [Anthropic Console](https://console.anthropic.com/) で、Claude Fable 5.1を利用できるAPIキーを用意します。
4. Google Cloudの既存プロジェクトのSecret Managerへ、次の名前で有効なシークレットバージョンを登録します。実際の値をGitやSlack、コマンド引数へ貼り付けないでください。

   | シークレット名 | 内容 |
   | --- | --- |
   | `anthropic-api-key` | Anthropic APIキー |
   | `claude-slack-bot-token` | 新しいClaudeアプリのBot User OAuth Token |
   | `claude-slack-signing-secret` | 新しいClaudeアプリのSigning Secret |

5. `@claude` を利用チャンネルとデプロイ通知先チャンネルへ招待します。

## 確認とデプロイ

```sh
cd /Users/tatsuya.mochizuki/openai-slack-bot/claude-bot
npm ci
npm test
npm run check
DEPLOYMENT_NOTIFICATION_CHANNEL_ID=C0123456789 \
ALLOWED_CHANNEL_IDS=C0123456789 \
npm run deploy -- --summary "Claude Fable 5.1・最大推論のbotを追加"
```

チャンネルIDは実際の値に置き換えます。初回に省略したチャンネル設定は、既存 `gpt-slack-bot` の設定から読み取ります。2回目以降はClaudeサービスの保存済み設定を優先します。利用チャンネルの設定がどちらにもなければ通知先だけを許可します。`ALLOWED_CHANNEL_IDS` を明示的に空にすると全チャンネルを許可します。

既定のGoogle Cloudプロジェクトは `mochiduki-gpt-slack-260713`、リージョンは `asia-northeast1` です。変更する場合は `GOOGLE_CLOUD_PROJECT` と `CLOUD_RUN_REGION` を指定します。Cloud Run・Cloud Build・Secret ManagerとFirestoreの既存環境、デプロイ権限が必要です。

デプロイスクリプトは必要なシークレットとFirestoreを先に確認し、`claude-slack-bot` サービスアカウントを作成してFirestore利用権限と上記3つのシークレットだけの読取り権限を付与します。ソースの送信元はこのディレクトリに固定され、`claude-slack-bot` サービスだけを更新します。開始・完了・失敗はClaudeのSlackトークンで通知します。

会話履歴の保存先は、既存 `gpt-slack-bot` の `FIRESTORE_CONVERSATION_COLLECTION` を読み取って同じ値に設定します。GPT側が未指定の場合は `slack_conversations` を使います。既存のClaudeサービスが別の保存先を使っている場合もGPTの保存先へ切り替えますが、旧コレクションの文書は自動移行しません。シェルで異なるコレクション名を指定するとデプロイ前にエラーになります。

モデル応答中もSlackの受付後に処理を継続できるよう、Cloud RunではCPUを常時割り当てます。最小インスタンス数は0、最大は3です。新しいリビジョンに100%配信されていることを確認後、サービスURLとSlackのRequest URLを表示します。

初回デプロイ後、Slackアプリの **Event Subscriptions** を有効にし、表示された `https://…/slack/events` をRequest URLに設定します。**Subscribe to bot events** に `app_mention` を追加して保存します。アプリの作成時点ではサービスURLがないため、マニフェストには仮のRequest URLを含めていません。

## 利用方法

```text
@claude この方針のメリットと課題を整理してください
@claude 最新情報を調べて、出典付きで説明してください
@claude 添付した画像を説明してください
@claude このPDFの結論と根拠をまとめてください
```

Botは `👀` で受付を示し、元メッセージのスレッドに回答します。同じスレッドで `@gpt` と `@claude` を切り替えても、質問・回答・解析結果のテキストを引き継ぎます。履歴はGPTと同じFirestoreコレクション（既定値 `slack_conversations`）へ保存し、切り替え先のOpenAIまたはAnthropicへ会話の文脈として送信します。Botをメンションしていない会話は参照しません。

添付ファイルの元データは共有履歴に保存しません。過去の画像やPDF、メディアを原本から再確認したい場合は、対応するBotへ再添付してください。

日本語は原則「です・ます調」で回答します。Web検索を使う場合は出典リンクを回答に含めます。モデルと最大推論の設定はソースで固定し、実行時の環境変数では変更しません。

添付ファイルはJPEG・PNG・GIF・WebP・PDFに対応し、1メッセージの合計20MiBまで受け付けます。画像は1枚7.5MiB以下です。本文・会話履歴・添付を含むAPI送信サイズにも上限があるため、長いスレッドでは新しいスレッドに分けてください。

最初のリリースには画像生成、音声・動画・YouTubeの解析、月次利用額通知を含めません。API呼出しはAnthropicだけを使用し、OpenAIの認証情報やメディアワーカーは不要です。

## ローカル起動

`.env.example` を `.env` にコピーして新しいSlackアプリの認証情報を設定し、`npm run start:local` で起動します。FirestoreへのApplication Default Credentialsも必要です。Slackからの受信確認には、そのアプリのRequest URLから接続できる公開HTTPSエンドポイントが必要です。ローカル起動の成功だけではSlack上の動作確認にはなりません。

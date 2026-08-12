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
  --set-env-vars OPENAI_MODEL=gpt-5.6-sol,OPENAI_REASONING_EFFORT=max,ALLOWED_CHANNEL_IDS=CHANNEL_ID
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

通常の会話用モデルは `gpt-5.6-sol`、推論強度は `max` です。運用上モデルや推論強度を切り替える場合は、Cloud Runまたはローカル環境の `OPENAI_MODEL` と `OPENAI_REASONING_EFFORT` を変更します。

回答は、ユーザーが別の口調を明示的に指定しない限り、丁寧で自然な口調になります。日本語では「です・ます調」を使用します。この設定は通常回答とPDF・動画・音声の解析結果に共通です。

最新情報・確認・リンクが必要な質問では、OpenAI APIのWeb検索を自動で利用します。検索を使った回答には情報源リンクを含めます。

Slack の許可チャンネルで、次のようにメンションしてください。

```
@gpt 今日の会議メモを3行で要約して
```

返信は元メッセージのスレッドに投稿されます。

### 画像の読取りと生成

画像を添付して `@gpt` をメンションすると、画像と質問を合わせて解析します。画像を生成したい場合は、たとえば次のように依頼してください。生成結果は同じスレッドに画像ファイルとして投稿されます。

```
@gpt 雨上がりの東京を走る猫型ロボットの画像を生成して
```

確実に画像生成だけを実行したい場合は、`image` コマンドを使えます。

```
@gpt image アザラシが夜の海を泳ぐ、映画のワンシーンのような画像
```

この機能にはSlackアプリの `files:read` と `files:write` 権限が必要です。マニフェストを更新後、アプリをワークスペースへ再インストールしてください。

`@gpt` へのメンションを受け取ると、Botは元メッセージへ `👀` リアクションを付けて受付を示します。この機能には `reactions:write` 権限も必要です。

### PDF・動画・音声の解析

PDFを添付して `@gpt` をメンションすると、本文だけでなく表・図表・ページ内の画像を含めて質問できます。動画・音声はSlackへ添付するか、公開済みのYouTube URLを含めて `@gpt` をメンションしてください。処理完了後、スレッドには要約・重要論点・時刻を投稿し、全文文字起こしをMarkdownファイルとして添付します。

```
@gpt このPDFの結論と注意点をまとめて
@gpt この動画の意思決定を時刻付きで要約して https://www.youtube.com/watch?v=...
```

- 動画・音声は15分以内。Slack添付は1GBまで、YouTubeは解析用の360pストリームを取得する。
- 動画・音声・YouTubeの解析はワークスペース全体で1日10本、月90本まで。PDFは件数上限の対象外。
- 文字起こしはFirestoreへ30日保存するが、元のPDF・音声・動画・抽出フレームはCloud Runの一時領域から処理直後に削除する。
- YouTubeは公開かつ取得可能な動画だけを対象にする。非公開、年齢制限、取得不能、15分超過の動画は処理しない。

メディア処理はCloud Tasksで非同期化した専用の非公開Cloud Runワーカーが担当します。`npm run deploy` はCloud Tasks、必要なサービスアカウントとIAM、ワーカー、受信サービスを順に設定します。初回だけSlackアプリの `files:read` と `files:write` を再承認してください。

### スレッド内の会話の継続

同じスレッドで再度 `@gpt` をメンションすると、ボットがそのスレッドで受け取った直近の質問と回答を文脈として引き継ぎます。人同士の投稿や、ボットをメンションしていない投稿は読み込みません。

履歴はFirestoreに発言ごとに保存するため、Cloud Runのインスタンス停止・再起動後も引き継がれます。保存件数・保存期間の制限は設けず、保存先はチャンネルIDとスレッドIDごとに分けられます。

### Firestoreの初期設定

Cloud Runと同じGoogle Cloudプロジェクトで、Firestore（Native mode）のデータベースを作成する。Cloud Runには、専用のサービスアカウントを割り当て、そのサービスアカウントに **Cloud Datastore User**（`roles/datastore.user`）だけを付与する。

```sh
PROJECT_ID=YOUR_PROJECT_ID
SERVICE_ACCOUNT=openai-slack-bot@${PROJECT_ID}.iam.gserviceaccount.com

gcloud services enable firestore.googleapis.com --project "$PROJECT_ID"
gcloud iam service-accounts create openai-slack-bot --project "$PROJECT_ID"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:$SERVICE_ACCOUNT" \
  --role roles/datastore.user

for SECRET in openai-api-key slack-bot-token slack-signing-secret; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --project "$PROJECT_ID" \
    --member "serviceAccount:$SERVICE_ACCOUNT" \
    --role roles/secretmanager.secretAccessor
done
```

Firestoreデータベースを作成後、Cloud Runのデプロイ時に `--service-account "$SERVICE_ACCOUNT"` を付けて割り当てる。Secret Managerの3つのシークレットに対する読み取り権限も付与する。Cloud Run上では、アプリケーションデフォルト認証でこのサービスアカウントが自動的に使われるため、認証情報ファイルや `GOOGLE_APPLICATION_CREDENTIALS` を設定しない。

会話履歴に保存期間は設けない。データ削除が必要になった場合は、Firestore上の対象スレッドを管理者が明示的に削除する。

保存済みの会話は全件をOpenAI APIへ渡す。長期スレッドでは、APIコスト・応答時間・モデルの入力上限に影響する可能性がある。

`FIRESTORE_CONVERSATION_COLLECTION` は保存先の親コレクション名で、既定値は `slack_conversations` です。

`OPENAI_IMAGE_MODEL` はResponses APIの画像生成ツールに使うモデルで、既定値は最新の `gpt-image-2` です。テキスト回答・画像読取りに使う `OPENAI_MODEL` とは分けているため、画像生成の品質は独立して指定できます。

### 毎月のOpenAI API利用額通知

毎月1日の9:00（日本時間）に、前月の利用額だけをBotが通知先Slackチャンネルへ投稿します。`npm run deploy` に組み込まれているため、初回だけSecret Managerに `openai-usage-admin-key` を作成してください。値は、OpenAI Platformで作成した **Admin key** のうち `api.usage.read` 権限を持つものです。通常のProject API keyでは利用額を取得できません。

通知先は `MONTHLY_USAGE_REPORT_CHANNEL_ID`（未指定ならデプロイ通知と同じ `DEPLOYMENT_NOTIFICATION_CHANNEL_ID`）です。Cloud Schedulerからの呼び出しはOIDCで認証し、通知済み月はFirestoreの `openai_usage_reports` に記録して重複投稿を防ぎます。

管理キーを登録後、次のデプロイでCloud RunのSecret参照、最小IAM、Cloud Schedulerジョブをまとめて設定します。

```sh
npm run deploy -- --summary "毎月1日に前月のOpenAI API利用額を通知"
```

### デプロイ通知

`DEPLOYMENT_NOTIFICATION_CHANNEL_ID` に通知先のチャンネルIDを設定すると、次のコマンドがBotとしてデプロイ開始・完了・失敗を投稿します。`--summary` は今回追加・変更した機能として投稿内容に含まれます。

```sh
npm run deploy -- --summary "@gpt image コマンドを追加"
```

デプロイ時は、直接 `gcloud run deploy` を実行せずこのコマンドを使う。

`npm run setup:media` はCloud TasksキューとIAMだけを明示的に再設定したい場合のコマンドです。ワーカーのIAM付与まで行うには、ワーカーをデプロイ後に `npm run setup:media -- --bind-worker` を実行します。

## 次の拡張候補

- Cloud Runのサービスアカウントを最小権限にする

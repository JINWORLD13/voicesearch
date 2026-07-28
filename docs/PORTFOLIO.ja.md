[한국어](PORTFOLIO.md) | **日本語**

# VoiceSearch

声で質問するとウェブを検索して根拠付きで答え、その回答を音声で読み上げる
検索サービス。新卒エンジニアのポートフォリオとして作った。

一行要約: 音声入力 → ウェブ検索 → LLMが根拠ベースの回答をストリーミング → 音声出力。
外部APIキーがなくても代替経路で動作するよう設計した。

---

## デモ

ライブリンク: https://voicesearch-cwh9.onrender.com (Renderの無料ティアなので初回リクエストは遅いことがある)

![検索画面 — 質問すると出典リストが先に表示され、回答がストリーミングされた後、音声で読み上げる](screenshots/search.png)

![障害注入後のダッシュボード — サーキットが開き、429と中断が集計され、イベントログにサーキットopenが残る](screenshots/dashboard.png)

ローカルでの実行方法は [README](../README.ja.md#実行方法) にある。

---

## アーキテクチャ

```
┌─────────────────────────────────────────────┐
│  ブラウザ (React + TypeScript, :5173)          │
│                                               │
│  マイク ── Web Speech API ──▶ テキスト          │
│                                 │             │
│  画面 ◀── SSEイベントパース ◀────┤             │
│  (出典カード / 回答ストリーミング) │             │
│                                 ▼             │
└─────────────────────────────┬─────────────────┘
                              │ POST /api/search
                              │ POST /api/voice
                              ▼
┌─────────────────────────────────────────────┐
│  サーバー (Express + TypeScript, :3001)        │
│                                               │
│  routes/search.ts ── 検索経路の選択 (指揮者)    │
│       │                                       │
│       ├─ EXA_API_KEY あり ─▶ exa.ts           │
│       │                      (ウェブ検索5件)   │
│       │                         │             │
│       │                         ▼             │
│       │                     llm.ts            │
│       │                  (Gemini/OpenAI生成)   │
│       │                                       │
│       └─ なし ─▶ llm.ts (Gemini内蔵Google検索) │
│                                               │
│  routes/voice.ts ── ElevenLabs TTSプロキシ     │
└─────────────────────────────┬─────────────────┘
                              │
                  ┌───────────┼───────────┐
                  ▼           ▼           ▼
              Gemini API   Exa API   ElevenLabs API
             (検索+生成)   (ウェブ検索) (音声合成)
```

データフロー一行:
質問テキスト → (検索) → 検索結果 → (LLM) → 回答の断片 → SSE → 画面 → (任意) mp3

---

## 技術選定の理由

### なぜ検索経路を2つ(Exa / Gemini内蔵検索)にしたのか

最初はExa検索API一本だった。しかしExaは会員登録とAPIキー発行が必要で、
このアプリを初めて起動する人がキーなしでは何も見られない問題があった。

GeminiにはGoogle検索の内蔵機能(grounding)がある。そこでExaキーがなければ
Geminiが自ら検索して答える経路へ自動で切り替えるようにした。結果として
GEMINI_API_KEY一つで全機能が動く。

両者のトレードオフ:

| | Exa経路 | Gemini内蔵検索 |
|---|---|---|
| 必要なキー | Exa + Gemini | Geminiのみ |
| 検索結果の制御 | 件数、本文抜粋を直接制御 | 制御不可 |
| 出典リンク | 元のURL | GoogleリダイレクトURL |
| 回答内の [1] 番号 | 可能 | 不可 |

細かい制御が必要ならExa、手軽さ優先なら内蔵検索。状況に合わせて選べるようにした。

### なぜLLMプロバイダーをGemini/OpenAIの両対応にしたのか

特定企業のAPIに縛られないよう、.envの値一つ(LLM_PROVIDER)で切り替えられるようにした。
両SDKはストリーミングレスポンスの形が違うが、どちらも「テキスト片を吐き出す
async generator」に包み、ルートのコードはどちらか知らなくて済むよう統一した。

### なぜSSEなのか (WebSocketではなく)

回答生成には4〜7秒かかる。全部作ってから一度に返すと、その間は空白の画面になる。
サーバーが断片をできた順に流せば、文字が積み上がっていく。

方向がサーバー→クライアントの単方向だけなのでSSEで十分。SSEはただのHTTPなので
WebSocketより単純。双方向(例: 生成中断シグナル)が必要になったら、そのとき
WebSocketを検討する。

### なぜ音声にフォールバックを置いたのか

ElevenLabsの無料プランは月1万クレジット制限で、いつ上限に達してもおかしくない。
音声生成が失敗したらブラウザ内蔵音声(speechSynthesis)で代わりに読み上げる。
デモ中にAPI上限のせいで音が出ない状況をなくすための設計。

---

## ぶつかった問題と解決

### 1. 外部検索APIが参入障壁になっていた問題

問題: Exa検索APIで作ったところ、アプリを初めて起動する人はExaの登録とキー発行を
先に済ませないと検索を試せなかった。ポートフォリオを見る人からすれば、キー一つの
せいで「検索結果がありません」というエラーしか見えない。

原因分析: 検索と生成がExaに強く結びついていた。検索を担当する部分だけ
差し替えられればよいのに、構造がそうなっていなかった。

解決: 検索ルートでキーの有無により経路を分けた。Exaキーがあれば従来どおり、
なければGemini内蔵のGoogle検索で検索と生成を一度に処理する。すでに持っていた
Geminiキーだけで全体が動くようになり、フロントはイベントタイプ基準で画面を
描くため、ほぼ手を入れずに済んだ(deltaでのphase遷移を1行追加しただけ)。

学んだこと: 外部依存は「ない場合の経路」を一緒に設計すべき。これは音声
フォールバック(ElevenLabs失敗 → ブラウザ音声)とも同じ原則で、アプリ全体に
一貫して適用した。

### 2. ストリーミング応答が途中で切れてパースが壊れた問題

問題: サーバーがSSEで流したイベントをフロントでJSON.parseするとき、たまに
パースが落ちた。再現しにくく、原因究明が厄介だった。

原因分析: ネットワークは自分が送ったイベント単位でデータを届けてくれない。
`data: {"type":"del` までだけ届いて、残りの `ta","text":"..."}` は次の
チャンクで来る、というようにイベント境界と無関係に切れて届く。届いた断片を
そのままパースしたので、半分に千切れたJSONでエラーになった。

解決: 受け取ったデータをバッファに溜め、イベント区切りである空行(\n\n)でだけ
切る。切ったとき最後の断片はまだ未完成の可能性があるためパースせず、次のターンの
ためにバッファへ残す。

```ts
// web/src/api.ts — 核心部分
buffer += decoder.decode(value, { stream: true });
const parts = buffer.split("\n\n");  // イベントは空行区切り
buffer = parts.pop() ?? "";          // 最後の未完成断片は残しておく
for (const part of parts) {
  if (part.trim().startsWith("data:")) onEvent(JSON.parse(part.trim().slice(5)));
}
```

学んだこと: ストリームはメッセージ単位ではなくバイト単位で届く。境界は自分で
管理しなければならないことを体感した。

---

## 過負荷・障害に耐える4層防御

遅くて(5〜7秒)時々失敗する外部AIをラップするサーバーなので、「多く処理すること」
より「外部が揺れても耐えること」を核心の課題と捉えた。

```
リクエスト → [1] Rate Limiter (IPごとのToken Bucket、自作) ─超過─▶ 429 安全な拒否
          → [2] Circuit Breaker (連続失敗で回路を開いて即時失敗)
          → [3] Bulkhead (外部APIごとのセマフォで並行性を隔離)
          → [4] Graceful Degradation (過負荷時はTTSから順に断念)
          → 正常処理 (+ LRU+TTLキャッシュで同じ質問に即応答)
```

負荷テストで実測した代表値:

- 回答キャッシュ: 質問が繰り返される負荷で p50 3905ms → 1ms、スループット2.7倍
- サーキットブレーカー: 失敗率50%の障害で壁時計時間を半減(16.5秒 → 8.9秒)、p50を6倍短縮
- Rate Limiter: 一つのIPの暴走は429で遮断、同じ瞬間の他IPは全件通過

ダッシュボードで「外部AIを殺す」などの障害を注入すると、サーキットが開いて
グラフが跳ねる様子をリアルタイムで観察できる。各層の代替案比較(ライブラリ/インフラ
レベル)と測定方法論は [RESILIENCE.ja.md](RESILIENCE.ja.md) にまとめた。障害注入
エンドポイントは訪問者が体験できるようデフォルトで公開しつつ、放置された操作は
最終操作の10分後に自動で正常化され、ADMIN_TOKENを設定すればロックできる。

---

## 指標

応答速度 (実測、Gemini内蔵検索経路、5つの質問):

| 質問 | 応答時間 |
|---|---|
| 2026年の最低賃金はいくら | 5.0秒 |
| 最近公開された映画のおすすめ | 5.9秒 |
| EV補助金は今年どう変わった | 7.0秒 |
| ソウルの今日の天気 | 4.6秒 |
| 為替レートは今いくら | 4.3秒 |

平均 約5.3秒 (検索 + LLM生成込み、最初の文字まではもっと速い)。

その他の指標 (デプロイ後に埋める枠):
- ユーザー数:
- 日次検索数:
- 最初の文字までの時間(TTFB):

---

## コアロジックのスニペット

全コードではなく、設計意図が表れる部分だけ抜粋。

### 検索経路の選択 (指揮者)

server/src/routes/search.ts — キーの有無で経路を分ける部分。

```ts
if (!process.env.EXA_API_KEY) {
  // Exaキーがなければ、Gemini内蔵Google検索で検索+生成を一度に
  for await (const event of streamGroundedAnswer(question)) {
    if (event.kind === "text") send({ type: "delta", text: event.text });
    else send({ type: "sources", sources: /* 参照したページ */ });
  }
  return res.end();
}

// Exaキーがあれば先に検索し、出典を回答より先に送る
const results = await searchWeb(question);
send({ type: "sources", sources: /* 5件 */ });
for await (const text of streamAnswer(question, results)) {
  send({ type: "delta", text });
}
send({ type: "done", elapsedMs: Date.now() - started });
```

### 2つのLLM SDKを1つに統一 (アダプター)

server/src/llm.ts — 形の違う2つのAPIを同じ殻で包んだ部分。

```ts
async function* streamGemini(prompt: string) {
  const stream = await ai.models.generateContentStream({ model, contents: prompt });
  for await (const chunk of stream) {
    if (chunk.text) yield chunk.text;            // Geminiは chunk.text
  }
}

async function* streamOpenAI(prompt: string) {
  const stream = await openai.chat.completions.create({ model, messages, stream: true });
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content; // OpenAIはここ
    if (text) yield text;
  }
}

// ルートはどのプロバイダーか知らなくてよい
export function streamAnswer(question, sources) {
  const prompt = buildPrompt(question, sources);
  return process.env.LLM_PROVIDER === "openai" ? streamOpenAI(prompt) : streamGemini(prompt);
}
```

### 外部呼び出しの保護膜: 4重を1回のcall()で

server/src/resilience/guard.ts — すべての外部API呼び出し(gemini, exa, elevenlabs)を
サーキットブレーカー → 再試行 → セマフォ → タイムアウトの順にラップする。再試行は
「治る病気」(429/5xxのような一時的エラー)だけを指数バックオフで再挑戦し、401(キー
エラー)のような「治らない病気」は即座に投げてユーザーに原因を知らせる。

```ts
const RETRYABLE = new Set([429, 500, 502, 503, 504]); // 一時的エラーだけ再試行

call<T>(fn: () => Promise<T>): Promise<T> {
  return this.breaker.run(() =>            // 1) サーキット: 死んだAPIは呼び出さず即時失敗
    withRetry(                             // 2) 再試行: 一時的エラーだけ 0.5s→1s→2s バックオフ
      () => this.semaphore.run(            // 3) セマフォ: APIごとの同時実行上限(Bulkhead)
        () => withTimeout(fn(), this.opts.timeoutMs, this.opts.label) // 4) タイムアウト
      ),
      this.opts.label,
      this.retryDelays
    )
  );
}
```

層の順序には理由がある。バックオフで待っている間はセマフォのスロットを掴んでおらず
(再試行がセマフォの外側)、死んだAPIは最も外側のサーキットが遮断して再試行すら行わない。

### 音声フォールバック

web/src/App.tsx — サーバー音声が失敗したらブラウザ音声へ。

```ts
const blob = await requestVoice(answer);   // 失敗時は null
if (blob) {
  new Audio(URL.createObjectURL(blob)).play();      // ElevenLabs mp3
} else {
  const u = new SpeechSynthesisUtterance(answer);   // ブラウザ内蔵音声
  u.lang = "ko-KR";
  speechSynthesis.speak(u);
}
```

---

## 技術スタック

- フロント: React (Vite, TypeScript)
- バックエンド: Node.js + Express (TypeScript)
- ウェブ検索: Gemini内蔵Google検索(デフォルト)または Exa API
- LLM: Gemini `gemini-3.6-flash`(デフォルト)または OpenAI、無料ティアで動作
- 音声入力: Web Speech API (ブラウザ内蔵)
- 音声出力: ElevenLabs TTS + speechSynthesisフォールバック
- レジリエンス: Rate Limiter / Circuit Breaker / Bulkhead / キャッシュを自作 (ユニットテスト26個、node:test)
- ロギング・可観測性: pino構造化ログ + インメモリメトリクス(p50/p95/p99) + リアルタイムダッシュボード
- 負荷テスト: 自作SSEスクリプト + k6

## 限界と今後の計画

- 音声認識がWeb Speech API依存でChrome系のみ動作。Whisper APIに替えれば
  ブラウザを選ばないが、録音アップロードの構造が必要になる。
- 単発の質問のみ対応(マルチターンなし)。
- 音声再生が回答生成の完了後に始まる。ElevenLabsのストリーミングAPIで文単位に
  先行生成すれば、最初の音までの待ち時間を減らせる。
- デプロイはRenderの無料ティアで公開済み(サーバーがリアクトのビルド結果も一緒に配信)。

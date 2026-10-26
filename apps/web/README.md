# じぶんAI — 顔の取り込みと表示（apps/web）

本人の顔を Web カメラ（または写真ファイル）から取り込んで細かく記録し、展示画面にホログラム風に表示する Next.js アプリ。
すべてローカルで動き、外部 API・CDN は使わない。

## セットアップ

```bash
npm i -g pnpm@10          # corepack が使えればそちらでもよい
pnpm install              # postinstall で MediaPipe の WASM を public/mediapipe/wasm にコピー
pnpm dev                  # http://localhost:3000
```

- 顔検出モデル `public/mediapipe/face_landmarker.task` はリポジトリに入っている。無くなったときだけ
  `pnpm --filter web setup:mediapipe` で再取得する（この時だけネットが必要）。
- DB と顔写真はリポジトリのルートの `data/`（Git 管理外）に保存する。場所は環境変数 `DATA_DIR` で変えられる。
  DB のテーブルは起動時に自動で作られる（`drizzle/` のマイグレーション）。

## 画面

| パス | 内容 |
|---|---|
| `/admin/persons` | 人物の登録・同意の記録と取り消し・展示に使う人物の選択・完全削除 |
| `/admin/persons/[personId]/face` | カメラ撮影／写真ファイルの取り込み・品質チェック・保存・使用中の顔の切り替え |
| `/admin/talk` | しゃべる顔の確認（WAV を入れて、静止画・試験サーバー・PC-A を通しで試す） |
| `/stage/face` | 展示画面（展示に使う 1 人を表示） |

## カメラ撮影

Web カメラの映像を毎フレーム解析しながら、段階ごとに記録する（`src/features/face/capture/`）。

1. 正面・真顔（展示に使う顔になる）
2. 左・右・上・下を向く
3. 笑顔・「あ」の口・「う」の口・眉を上げる
4. 自然な動き 10 秒（省略可）

- 条件（目標の向き・表情・品質チェック・動きの速さ）を決められた秒数満たし続けたら記録する。
  記録した区間の中で、一番くっきりして止まっていて目が開いているフレームをキーフレームに選ぶ。
- 動画ならではの判定：動きの速さ、顔の見失い、明るさのゆらぎ。
- タイムアウトしたら、今までで一番よい瞬間で記録できる（「注意」つき）。
- 撮影後の確認画面で、段階ごとに撮り直せる。
- 段階の中身・目標値・秒数は `config.ts` の `capture.steps` で変えられる。
  顔の向きの符号が実機で逆だったら `capture.poseSign` を反転する。

保存先: `data/persons/<personId>/face/<sessionId>/`

| ファイル | 内容 |
|---|---|
| `session.json` | 段階ごとの判定、表情の幅（真顔の基準と各表情の最大値）、動きの特徴（まばたきの頻度・頭の揺れなど）、カメラ情報、しきい値 |
| `<stepId>/original.jpg` | キーフレームの元画像（カメラの解像度のまま） |
| `<stepId>/face.png` | キーフレームの 512×512 切り出し |
| `<stepId>/landmarks.json` | キーフレームのランドマーク・向き・ブレンドシェイプ |
| `<stepId>/timeline.json` | 全フレームの向き・ブレンドシェイプ・顔の位置など |
| `<stepId>/clip.webm` | その段階の録画（音声なし） |

サーバーは timeline と landmarks から判定をやり直し、不合格の段階があれば保存しない。

## 肩から上の画像（顔を動かす元画像）

正面の顔（写真ファイル・カメラの正面の段階）から、肩から上を切り出して背景を切り抜く（`bust.ts` / `bust-render.ts`）。

- `bust.png`：肩から上（背景つき）、`bust_cutout.png`：背景を透明にしたもの。既定 1024×1024
- 切り抜きは MediaPipe の `selfie_multiclass_256x256`（人物・髪・服などを分けるモデル、16MB、リポジトリに同梱）
- 範囲・余白・切り抜きのなめらかさは `config.ts` の `bust`
- 品質チェックに「肩まで写っているか」（はみ出し 5% を超えると注意）を追加
- 展示画面は切り抜きがあればそちらを表示し、ゆっくり呼吸しているように少しだけ拡大縮小する

## 顔を動かす処理（PC-A）とのつなぎ

`renderer.ts` の `FaceRenderer` を実装したものを使う。

| 実装 | 内容 |
|---|---|
| `StaticFaceRenderer` | 静止画を音声の長さぶん流す（PC-A が無い・落ちたとき） |
| `RemoteFaceRenderer` | PC-A のサービス（`services/face-renderer`）につなぐ |
| 試験サーバー（`/api/dev/renderer`） | Next 内の PC-A のまね。元画像をそのまま流す（口は動かない） |

- やり取りの形式：`services/face-renderer/PROTOCOL.md`（WAV を送ると、できたフレームから順に返る）
- `speech-player.ts`：映像を少しためてから音声を鳴らし、以後は音声の時計に合わせて描く
- 使う PC-A：`.env.local` に `NEXT_PUBLIC_FACE_RENDERER_URL=http://<PC-AのIP>:8000`（CSP にも自動で加わる）。
  `mock` にすると試験サーバー。つながらなければ静止画に切り替える

## 仕組み

- 顔の解析・品質チェック・切り出しはブラウザで行う（`src/features/face/analyze.ts`）。
  サーバーは受け取った値で品質チェックをやり直し、不合格なら保存しない。
- しきい値と切り出しの比率は `src/features/face/config.ts` にまとまっている。
  各項目は「合格ライン(pass)」と「不合格ライン(fail)」を持ち、その間が「注意」。
- 保存先: `data/persons/<personId>/face/<assetId>/{original.jpg, face.png, landmarks.json}`
  - `original.jpg` は向きを直して再エンコードしたもの（EXIF・位置情報は残らない）
  - `landmarks.json` は元画像と 512×512 切り出しの両方のランドマーク、顔の向き、ブレンドシェイプ、
    品質チェックの結果、撮影日時、使ったしきい値
- 同意（`consentAt`）が無い人物は、写真を取り込めず、展示画面にも出ない。
- ブラウザからの通信は CSP `connect-src 'self'` で自分のサーバーだけに限っている
  （MediaPipe が内蔵する利用統計の送信を止めるため）。

## 次の段階への差し込み口

`src/features/face/renderer.ts` の `FaceRenderer` を実装すれば顔の動かし方を差し替えられる。
今は静止画を流すだけの `StaticFaceRenderer`。`speak()` には声のサービス（PC-A）が返す WAV を渡し、
`VideoFrame` を順に受け取る。

## コマンド

```bash
pnpm test        # Vitest（品質チェック・切り出し・姿勢・EXIF・WAV など純粋な関数）
pnpm typecheck
pnpm build
pnpm --filter web db:generate   # schema.ts を変えたらマイグレーションを作る
```

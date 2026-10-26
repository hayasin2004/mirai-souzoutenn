# 展示PC ⇄ PC-A（顔を動かすサービス）のやり取り

展示PC の Web アプリ（ブラウザ）が、同じ LAN の PC-A に直接つなぐ。
実装は 2 つあり、同じ形式で動くことを確認済み:

- Web 側：`apps/web/src/features/face/renderer-protocol.ts`（`RemoteFaceRenderer` と開発用の試験サーバー）
- PC-A 側：`services/face-renderer/face_renderer/protocol.py`

## エンドポイント

### `GET /health`

```json
{ "status": "ok", "backend": "static", "version": "0.1.0" }
```

展示PC はこれが 1.5 秒以内に返らなければ、静止画の表示に切り替える。

### `POST /prepare`（multipart/form-data）

| 項目 | 内容 |
|---|---|
| `source` | 動かす元画像。**肩から上・背景は黒**の PNG（既定 1024×1024） |
| `landmarks` | `landmarks.json` の中身（任意）。`bust.landmarks` に元画像に対する 478 点（0〜1） |
| `assetId` | 展示PC 側の写真 ID。同じ ID なら特徴量を使い回してよい |

```json
{ "sourceId": "f91bf1c5…", "width": 1024, "height": 1024 }
```

### `POST /speak?sourceId=…&fps=25`（本文：`audio/wav`）

声のサービスが返した WAV をそのまま送る。応答は `Content-Type: application/x-face-frames` のフレームの列で、
**できたフレームから順に**送る（全部できるのを待たない）。

- 知らない `sourceId` → 404、WAV でない → 400（フレームを送り始める前に判定する）
- 送り始めてから失敗したら、`error` メッセージを送って終える

## フレームの列

次のメッセージを順に並べたもの。

```
[uint32 BE: ヘッダの長さ][ヘッダ: UTF-8 JSON][uint32 BE: 本体の長さ][本体: バイト列]
```

| ヘッダ | 本体 |
|---|---|
| `{"type":"frame","index":0,"timestampUs":0,"durationUs":40000,"mime":"image/jpeg","width":1024,"height":1024}` | 画像（JPEG / PNG / WebP） |
| `{"type":"end","frames":120}` | 空 |
| `{"type":"error","message":"…"}` | 空 |

- `timestampUs` は**音声の先頭を 0 とした再生位置**（マイクロ秒）。
- 展示PC は映像を 240ms 分ためてから音声を鳴らし始め、以後は音声の時計に合わせて描く。
  映像が遅れると直前のフレームのまま止まり、進みすぎたフレームは捨てる。
  → 生成は**実時間より速く**（1 秒の音声の映像を 1 秒未満で）できる必要がある。

## CORS

展示PC の Web アプリのオリジンを `FACE_RENDERER_ALLOW_ORIGINS` に入れる。
展示PC 側は `NEXT_PUBLIC_FACE_RENDERER_URL` に PC-A の URL を入れると、CSP の `connect-src` にも自動で加わる。

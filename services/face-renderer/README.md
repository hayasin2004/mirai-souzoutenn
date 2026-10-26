# 顔を動かすサービス（PC-A）

展示PC から「肩から上の写真」と「声の WAV」を受け取り、しゃべる顔の映像をフレームの列で返す FastAPI サービス。
やり取りの形式は [PROTOCOL.md](PROTOCOL.md)。

## 今の状態

| 部分 | 状態 |
|---|---|
| FastAPI の土台（`/health` `/prepare` `/speak`、CORS、GPU のロック） | できている・テスト済み |
| `static` backend（静止画を流すだけ） | できている。通信・同期の確認用 |
| `ditto` backend（Ditto ＋ LivePortrait） | **まだ**。PC-A の GPU 環境で作る（`face_renderer/backends/ditto.py`） |

## 起動（static で試す）

```bash
cd services/face-renderer
python -m venv .venv
.venv\Scripts\activate            # Mac/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m pytest                  # 形式のテスト

set FACE_RENDERER_ALLOW_ORIGINS=http://<展示PCのIP>:3000
uvicorn face_renderer.main:app --host 0.0.0.0 --port 8000
```

展示PC 側（apps/web）は `.env.local` に次を書いて起動し直す:

```
NEXT_PUBLIC_FACE_RENDERER_URL=http://<PC-AのIP>:8000
```

管理画面の「しゃべる確認」（`/admin/talk`）で「PC-A」を選び、WAV を入れて再生する。

## Ditto をつなぐ（PC-A で行う）

1. **環境**：NVIDIA GPU（RTX 30 系以上を目安）、CUDA、TensorRT。Ditto は Linux 前提なので、Windows なら WSL2 か Linux。
2. **単体で動かす**：Ditto（antgroup/ditto-talkinghead）の手順どおりにモデルを入れ、
   展示PC で保存した `bust.png`（`data/persons/<id>/face/<sessionId>/front/`）を黒背景にしたものと
   手元の WAV で、オフラインで動画を作る。ここで次を測る:
   - 1 秒の音声の映像を作るのにかかる時間（**1 秒未満**でないとリアルタイムで流せない）
   - 最初のフレームができるまでの時間
   - 1024 で出せるか（遅ければ 512 で作って展示PC で拡大）
3. **`ditto.py` を実装する**：`prepare` で特徴量を作ってキャッシュし、`generate` でできたフレームから順に JPEG にして yield する。
   Ditto のオンライン（逐次）推論を使うと最初のフレームが早く出る。
4. `FACE_RENDERER_BACKEND=ditto` で起動し、`python -m pytest` と「しゃべる確認」で確かめる。

## 削除について

展示PC で人物を削除しても、PC-A のキャッシュは消えない。`ditto.py` でキャッシュをディスクに置く場合は、
削除用のエンドポイントを足すか、起動のたびに消す運用にする。

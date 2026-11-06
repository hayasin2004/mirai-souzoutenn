# 簡易音声クローン プロトタイプ（Fish Audio API）

30秒ほどの音声から声のモデルを作り、好きな文章をその声で読み上げる Python CLI です。
（調査日: 2026-10-09）

## 仕組み

```
参考音声(30秒) ──▶ [文字起こし ASR] ──▶ [声モデル作成 POST /model] ──▶ voice_id を voices.json に保存
                                                                    │
読み上げたい文章 ─────────────────────────────▶ [TTS /v1/tts reference_id=voice_id] ──▶ output/*.mp3
```

- `clone` … 一度だけモデルを作り、何度でも使い回す（おすすめ）
- `instant` … モデルを作らず、毎回参考音声を送ってその場でクローン（お試し向け）

## セットアップ

1. https://fish.audio でアカウント作成 → https://fish.audio/app/api-keys で API キーを発行
2. このフォルダでターミナルを開いて:

```bash
python -m venv .venv
# Windows:  .venv\Scripts\activate
# Mac/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

3. `.env.example` をコピーして `.env` にリネームし、APIキーを貼り付け

Python 3.10 以上が必要です。

## 使い方

```bash
# 1) 声を登録（初回に同意確認が出ます）
python voice_clone.py clone my_voice.wav --name tako

# 2) その声で読み上げ → output/ に mp3 が保存される
python voice_clone.py say "今日はいい天気ですね。散歩に行きましょう。" --voice tako

# 速さ・形式・保存先を指定
python voice_clone.py say "ゆっくり話します" --voice tako --speed 0.8 --format wav -o slow.wav

# モデルを作らずに1回だけ試す
python voice_clone.py instant my_voice.wav "お試しです"

# 一覧 / 削除
python voice_clone.py list
python voice_clone.py delete tako
```

## 参考音声のコツ

| 項目 | 推奨 |
|---|---|
| 長さ | 15〜30秒（最低10秒）。1〜2分あるとさらに似る |
| 話者 | 1人だけ。BGM・反響・他人の声なし |
| 形式 | wav / mp3 / m4a / opus |
| 内容 | 普段の話し方で、感情を込めすぎない文章を読む |

スマホのボイスメモで静かな部屋で録れば十分です。

## 料金（2026年10月時点）

| 機能 | モデル | 料金 |
|---|---|---|
| 読み上げ（既定） | `s2.1-pro-free` | **無料**（テスト・開発向け、速度保証なし） |
| 読み上げ（本番） | `s2.1-pro` | $15 / 100万バイト（日本語で約30万文字） |
| 文字起こし | `transcribe-1-pro` | $0.36 / 音声1時間（30秒で約0.3円） |

文字起こしを使わない場合は `--text "参考音声で話している内容"` か `--no-transcribe` を付けてください。

## 注意

- 自分の声、または本人の同意を得た声だけを使ってください。他人の声を無断で使うと、肖像権・パブリシティ権や詐欺などの問題になります。
- モデルは `private`（自分だけが使える）で作成しています。
- `.env` と `voices.json` は Git に上げないでください。

---

# 自分の分身アバター（fal.ai / Kling AI Avatar v2）

正面の顔写真 1 枚と音声から、声に合わせて口・表情・頭が動く動画（mp4）を作る `avatar.py`。
声は上の `voice_clone.py` のものをそのまま使える。（調査日: 2026-11-02）

```
顔写真 ──▶ [register] ──▶ avatars/<名前>.jpg（avatars.json に登録）
                                   │
音声(mp3/wav) or 文章 ──▶ [say なら voice_clone で読み上げ] ──▶ [fal.ai Kling AI Avatar v2] ──▶ output/*.mp4
```

## セットアップ

1. https://fal.ai でアカウント作成 → https://fal.ai/dashboard/keys で API キーを発行
2. `.env` に `FAL_KEY=...` を追加
3. `pip install -r requirements.txt`

## 使い方

```bash
# 1) 顔写真を登録（初回に同意確認が出ます）
python avatar.py register face.jpg --name tako

# 2) 音声に合わせてしゃべらせる → output/ に mp4 が保存される
python avatar.py speak test.mp3 --avatar tako
python avatar.py speak test.mp3 --avatar tako --emotion 嬉しい

# 3) クローンした声で読み上げ → そのまま動画に（文頭の [嬉しい] などは表情にも使う）
python avatar.py say "[嬉しい]今日はいい天気ですね" --voice tako --avatar tako

# 一覧 / 削除
python avatar.py list
python avatar.py delete tako
```

| オプション | 内容 |
|---|---|
| `--emotion` | 普通 / 嬉しい / 怒る / 悲しい |
| `--prompt` | 表情・動きの指示を直接書く（英語の方が効きやすい） |
| `--quality` | `standard`（約 $0.056/秒、既定）/ `pro`（約 $0.115/秒） |

## 顔写真のコツ

| 項目 | 推奨 |
|---|---|
| 向き・表情 | 正面、真顔、口を閉じて目を開ける |
| 画質 | 長辺 1000px 以上、ピントが合っている、顔に影がない |
| 範囲 | 頭の上から肩まで。背景は無地 |
| その他 | 眼鏡・マスクなし。前髪が目にかからない |

顔写真と音声は fal.ai にアップロードされます。自分の顔、または本人の同意を得た顔だけを使ってください。

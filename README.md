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

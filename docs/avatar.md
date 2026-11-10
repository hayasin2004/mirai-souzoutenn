# アバターに喋らせる（avatar）

Fish Audio でクローンした声を、Anam のアバター（顔）に渡して喋らせます。

```
文章 → [喋り方の調整] → Fish Audio（クローンした声で読み上げ）→ Anam（口を合わせた映像）→ ウィンドウ＋スピーカー
```

- Fish Audio … 声を担当（これまでと同じ）
- Anam … 顔だけ担当。「オーディオパススルー」モードで、渡した音声に合わせて口を動かした映像を返す
- Anam 内蔵の AI や声は使いません

## セットアップ

1. 追加のパッケージを入れる

```bash
pip install -r requirements-avatar.txt
```

2. Anam Lab（https://lab.anam.ai）で API キーを発行する
3. 使いたいアバターの ID を確認する（https://lab.anam.ai/avatars で自分の写真から作ったアバターを開く）
4. `.env` に追記する

```
ANAM_API_KEY=発行したキー
ANAM_AVATAR_ID=アバターのID
```

`ANAM_AVATAR_ID` を書かないと、Anam 公式のサンプルアバターで動きます。

## 使い方

```bash
# まず Anam だけ動くか確認（Fish Audio を使わず、手元の音声ファイルを喋らせる）
python voice_clone.py avatar --audio test.mp3

# クローンした声で1回喋らせる（speak と同じ喋り方の調整が入る）
python voice_clone.py avatar "[嬉しい]こんにちは！来てくれてありがとう。" --voice tako

# 打った文章を次々に喋らせる（接続したまま、何回でも）
python voice_clone.py avatar --voice tako -i
```

## 写真から顔を作る

手元の写真1枚から、Anam のアバター（顔）を作れます。作った顔は `avatars.json` に名前で保存されます（`voices.json` と同じ仕組み）。

```bash
# 写真から顔を作って「tako」という名前で保存（数十秒かかる）
python voice_clone.py avatar-create me.jpg --name tako

# 作った顔と、クローンした声で喋らせる
python voice_clone.py avatar "こんにちは！" --voice tako --face tako

# 写真から顔を作って、そのまま喋らせる（展示では撮った写真をここに渡す想定）
python voice_clone.py avatar "こんにちは！" --voice tako --image me.jpg

# 作った顔の一覧
python voice_clone.py avatar-list
```

写真のコツ（Anam の安全チェックで弾かれにくくするため）:

| 項目 | 推奨 |
|---|---|
| 写っている人 | 1人だけ。18歳以上 |
| 撮り方 | 正面・明るい場所・肩まで写す |
| 加工 | 美肌フィルターなどの加工なし（若く判定されやすい） |
| 形式 | JPEG / PNG / WebP、4.5MB まで（それ以外や大きい写真は自動で JPEG に変換して縮める） |

- 写真のチェックは1日の回数に上限があります（無料プランは1日10回、弾かれた写真も数える）
- そのため `avatar --image` は、文章や `--voice` の指定漏れがあれば写真を送る前に止まります
- 作った直後は Anam 側で準備中のことがあります。接続でエラーが出たら少し待ってからやり直してください

## 喋らせるときのメモ

- 映像は別ウィンドウに出ます。ウィンドウ上で `q` を押すと終了します
- `-i` のときは、空のまま Enter か `q` を入力すると終了します
  （入力待ちのときにウィンドウで `q` を押した場合は、コンソールで Enter も押してください）

| オプション | 内容 |
|---|---|
| `--voice` | clone でつけた名前、または voice_id |
| `--audio` | Fish Audio を使わず、この音声ファイルを喋らせる |
| `-i` / `--interactive` | 打った文章を次々に喋らせる |
| `--face` | avatar-create でつけた名前、またはアバター ID（省略時は `.env` の `ANAM_AVATAR_ID`） |
| `--image` | この写真から顔を作ってから喋らせる |
| `--face-name` | `--image` で作る顔の名前（省略時は写真の名前＋日時） |
| `--file` | 文章をテキストファイルから読む |
| `--speed` / `--temperature` / `--model` / `--no-normalize` | say と同じ |
| `--no-emotion` など | speak と同じ喋り方の調整オプション |

## 仕組みのメモ

- Fish Audio の mp3 を、Anam が受け付ける形（16bit・モノラル・24000Hz の生データ）に変換して送っています（`voice/avatar.py` の `to_pcm16`）
- 送り終わったら `end_sequence()` を呼びます。呼ばないと、続きの音声を待ったまま映像が止まります
- スピーカーから鳴るのは Anam から返ってきた音声（映像と口の動きが同期済み）です
- 1つ目の音声は Anam に接続する前に作ります。Fish Audio で失敗したときに Anam の時間を無駄にしないためです

## 料金・注意

- Anam はアバターに接続している時間で課金されます。Fish Audio の料金は別です
- オーディオパススルーは Anam ではまだベータ機能なので、SDK の更新で動かなくなることがあります（動作確認: anam 0.12.0）
- 今は「文章を全部読み上げてから送る」作りなので、喋り出すまでに Fish Audio の生成時間ぶん待ちます。展示で間を詰めるなら、Fish Audio のストリーミングで少しずつ送る形に変えるのが次の一手です
- 顔写真・声とも、本人の同意を得たものだけを使ってください

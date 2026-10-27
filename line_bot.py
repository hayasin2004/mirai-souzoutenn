"""
LINE Bot 連携 & 会話ログ蓄積・AI人格学習モジュール
"""

import base64
import hashlib
import hmac
import json
import os
import random
import re
import threading
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
LOGS_FILE = DATA_DIR / "line_logs.json"
USERS_FILE = DATA_DIR / "line_users.json"
TOPIC_HISTORY_FILE = DATA_DIR / "topic_history.json"
PERSONA_FILE = BASE_DIR / "persona.txt"

load_dotenv(BASE_DIR / ".env")

_logs_lock = threading.Lock()


def sanitize_line_text(text: str) -> str:
    """
    LINEのトーク履歴やチャットテキストに含まれる表示不能文字・制御文字・不正サロゲート・外字等を除去・正規化
    Windows環境(CP932)の標準出力やファイル保存でも絶対にクラッシュしない堅牢な実装
    """
    if not text or not isinstance(text, str):
        return ""

    # 1. コードポイント走査による安全な除外（サロゲート、私用領域、制御文字、不可視文字、置換文字\ufffd）
    clean_chars = []
    for c in text:
        cp = ord(c)
        # 孤立サロゲート (0xD800 - 0xDFFF)
        if 0xD800 <= cp <= 0xDFFF:
            continue
        # 私用領域・外字・独自絵文字 (0xE000 - 0xF8FF, 0xF0000 - 0xFFFFD, 0x100000 - 0x10FFFD)
        if 0xE000 <= cp <= 0xF8FF or 0xF0000 <= cp <= 0xFFFFD or 0x100000 <= cp <= 0x10FFFD:
            continue
        # C0 / C1 制御文字（改行 \n, \r とタブ \t 以外）
        if (cp < 0x20 and c not in "\n\r\t") or (0x7F <= cp <= 0x9F):
            continue
        # 不可視文字・BOM・ゼロ幅スペース・双方向テキスト制御文字・置換文字 \ufffd
        if c in "\ufeff\u200b\u200c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2060\u2066\u2067\u2068\u2069\ufffd":
            continue
        clean_chars.append(c)

    text = "".join(clean_chars)

    # 2. Unicode NFKC 正規化（全角記号や互換文字を整える）
    try:
        text = unicodedata.normalize("NFKC", text)
    except Exception:
        pass

    # 3. 3つ以上の連続改行を2つに圧縮
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()


def fallback_parse_line_text(text: str) -> List[Dict[str, Any]]:
    """
    GeminiによるJSON構造化抽出が失敗した時のフォールバック:
    LINEトーク履歴の一般的なテキスト形式からルールベースで会話を救済抽出
    """
    lines = text.splitlines()
    items: List[Dict[str, Any]] = []

    last_user_msg = None
    line_pattern = re.compile(
        r"^(?:\d{1,2}:\d{2}(?::\d{2})?|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}(?:\s+\d{1,2}:\d{2})?)\s+([^\s\t:]+)[\s\t:](.*)$"
    )

    for line in lines:
        line_str = line.strip()
        if not line_str:
            continue

        # システムメッセージ・日付行をスキップ
        if re.match(r"^\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}", line_str) and len(line_str) < 30:
            continue
        if any(keyword in line_str for keyword in ["[LINE]", "トーク履歴", "保存日時", "通話を終了しました", "グループに参加しました"]):
            continue

        match = line_pattern.match(line_str)
        if match:
            sender = match.group(1).strip()
            content = match.group(2).strip()

            # 市川拓（本人）判定
            is_user = any(k in sender for k in ["拓", "市川", "本人", "自分", "User", "私"])

            if is_user:
                if last_user_msg:
                    items.append({
                        "user_message": last_user_msg,
                        "ai_reply": "（LINEトーク履歴より記録）",
                        "timestamp": datetime.now().isoformat(),
                    })
                last_user_msg = content
            else:
                if last_user_msg:
                    items.append({
                        "user_message": last_user_msg,
                        "ai_reply": content,
                        "timestamp": datetime.now().isoformat(),
                    })
                    last_user_msg = None
                else:
                    items.append({
                        "user_message": f"（相手の呼びかけ: {content}）",
                        "ai_reply": content,
                        "timestamp": datetime.now().isoformat(),
                    })
        else:
            # メッセージの複数行継続
            if last_user_msg:
                last_user_msg += "\n" + line_str

    if last_user_msg:
        items.append({
            "user_message": last_user_msg,
            "ai_reply": "（LINEトーク履歴より記録）",
            "timestamp": datetime.now().isoformat(),
        })

    return items


def parse_chat_json_safely(raw_json: str, original_raw_text: str = "") -> List[Dict[str, Any]]:
    """
    Geminiから返されたJSONテキストを、制御文字やエスケープ不備・マークダウン囲みがあっても堅牢にパース
    """
    if not raw_json:
        return fallback_parse_line_text(original_raw_text) if original_raw_text else []

    cleaned = raw_json.strip()

    # マークダウンのコードブロック除去
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()

    # 1. 直接 json.loads(..., strict=False) を試行
    try:
        data = json.loads(cleaned, strict=False)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return [data]
    except Exception:
        pass

    # 2. JSON配列 [ ... ] を正規表現で抽出してパース
    array_match = re.search(r"\[[\s\S]*\]", cleaned)
    if array_match:
        try:
            data = json.loads(array_match.group(0), strict=False)
            if isinstance(data, list):
                return data
        except Exception:
            pass

    # 3. 各オブジェクト { ... } を1件ずつ正規表現で抽出
    obj_pattern = re.compile(r"\{[^{}]*?\"user_message\"[^{}]*?\}", re.DOTALL)
    matches = obj_pattern.findall(cleaned)
    items = []
    for m in matches:
        try:
            obj = json.loads(m, strict=False)
            if isinstance(obj, dict):
                items.append(obj)
        except Exception:
            # 簡易キーバリュー抽出
            u_match = re.search(r'"user_message"\s*:\s*"(.*?)"(?=,\s*"|\s*\})', m, re.DOTALL)
            a_match = re.search(r'"ai_reply"\s*:\s*"(.*?)"(?=,\s*"|\s*\})', m, re.DOTALL)
            t_match = re.search(r'"timestamp"\s*:\s*"(.*?)"(?=,\s*"|\s*\})', m, re.DOTALL)
            if u_match:
                items.append({
                    "user_message": u_match.group(1),
                    "ai_reply": a_match.group(1) if a_match else "（LINEトーク履歴より記録）",
                    "timestamp": t_match.group(1) if t_match else "",
                })
    if items:
        return items

    # 4. フォールバック: LINEトーク履歴から直接抽出
    if original_raw_text:
        return fallback_parse_line_text(original_raw_text)

    return []


# 分身AIの人格を豊かにするための多彩なインタビュー話題カテゴリ（全15ジャンル）
INTERVIEW_TOPIC_CATEGORIES: List[Dict[str, str]] = [
    {
        "id": "school_tech",
        "name": "学校・プログラミング・将来",
        "hints": "専門学校の授業や課題、プログラミングで面白いこと・苦戦してる言語、作ってみたいアプリ、将来の進路や就職のイメージ",
        "sample": "専門学校の授業で最近一番面白いやつって何？",
    },
    {
        "id": "daily_habits",
        "name": "日常の習慣・ルーティン・こだわり",
        "hints": "朝起きて一番にすること、夜寝る前の癖、部屋の配置やこだわり、出かける時の持ち物、リフレッシュ方法",
        "sample": "拓さんって朝起きて一番に何する派？二度寝しちゃう？",
    },
    {
        "id": "food_gourmet",
        "name": "食生活・グルメ・飲食のこだわり",
        "hints": "ラーメン以外の好きなご飯、苦手・食べられないもの、コンビニでつい買っちゃうもの、自炊事情、思い出の味",
        "sample": "一蘭以外で、最近めっちゃ美味しかったご飯とかある？",
    },
    {
        "id": "friends_relationships",
        "name": "人間関係・友人・家族",
        "hints": "友達と遊ぶ時の定番パターン、仲良くなりやすい人の特徴、休日に誰と過ごすことが多いか、連絡の頻度やLINEの返し方",
        "sample": "友達と遊ぶ時って、ノリで決めるタイプ？それとも計画立てる？",
    },
    {
        "id": "entertainment_culture",
        "name": "エンタメ・音楽・動画・アニメ",
        "hints": "好きな音楽やよく聴くアーティスト、YouTubeで見るチャンネル、最近ハマったアニメ・映画、漫画",
        "sample": "YouTubeで気づいたら見ちゃう動画のジャンルとかある？",
    },
    {
        "id": "game_digital",
        "name": "ゲーム・スマホ・デジタルライフ",
        "hints": "にゃんこ大戦争以外のゲーム歴、PCのこだわり、スマホで一番開いてるアプリ、SNSの見方",
        "sample": "昔一番やり込んだゲームとかって何だった？",
    },
    {
        "id": "values_emotion",
        "name": "価値観・喜怒哀楽・性格",
        "hints": "最近一番爆笑したこと、どうしても許せない・イラッとする瞬間、テンションが上がる瞬間、大事にしている考え方",
        "sample": "最近一番テンション上がったことって何だった？",
    },
    {
        "id": "shopping_lifestyle",
        "name": "買い物・持ち物・ファッション",
        "hints": "最近買って一番良かったもの、服を選ぶ時のこだわり、つい無駄遣いしちゃうもの、ずっと欲しいと思っている物",
        "sample": "今年買ったものの中で『これ買って大正解だった！』ってやつある？",
    },
    {
        "id": "holiday_travel",
        "name": "休日のお出かけ・ドライブ・旅行",
        "hints": "休日にふらっと出かける場所、今まで行った旅行で一番良かったところ、行ってみたいスポット",
        "sample": "休みの日にふらっと出かけるならどこ行くことが多い？",
    },
    {
        "id": "body_health_sleep",
        "name": "睡眠・運動・リフレッシュ",
        "hints": "何時間寝ると一番調子いいか、寝相や寝起きの良さ、サウナ以外の運動、疲れを取るための工夫",
        "sample": "拓さんって普段何時間くらい寝るのが一番ベスト？",
    },
    {
        "id": "convenience_snack",
        "name": "コンビニ・お菓子・夜食の定番",
        "hints": "コンビニに行くとつい買っちゃうスイーツやアイス、夜中にお腹空いた時に食べるもの、好きな飲み物",
        "sample": "コンビニ行ったら絶対カゴに入れちゃうやつとかある？",
    },
    {
        "id": "stress_relief",
        "name": "やる気の出し方・息抜き・気分転換",
        "hints": "課題や勉強でやる気出ない時の対処法、一番リラックスできる時間、イライラした時の発散法",
        "sample": "やる気出ない時ってどうやって切り替えてる？",
    },
    {
        "id": "fashion_room",
        "name": "自分の部屋・持ち物のこだわり",
        "hints": "部屋で一番お気に入りの場所、机の上の散らかり具合、よく着る服の系統や色",
        "sample": "自分の部屋の中で一番落ち着く場所ってどこ？",
    },
    {
        "id": "memories_past",
        "name": "過去の思い出・学生時代",
        "hints": "小中高の部活動や学校行事の思い出、子供の頃夢中だった遊び、昔と今で変わったところ、学生時代の面白エピソード",
        "sample": "子供の頃ってどんな遊びに一番ハマってた？",
    },
    {
        "id": "hypothetical_future",
        "name": "もしも・究極の選択",
        "hints": "もし1億円当たったらどうする？、1週間完全フリーでどこでも行けるならどこ行く？、超能力が1つ手に入るなら何がいい？",
        "sample": "もし1週間完全フリーでどこでも行っていいなら何する？",
    },
]


def get_topic_categories() -> List[Dict[str, str]]:
    """話題カテゴリ一覧を返す"""
    return INTERVIEW_TOPIC_CATEGORIES


def load_topic_history() -> Dict[str, Any]:
    """過去の話題選定履歴を読み込む"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not TOPIC_HISTORY_FILE.exists():
        return {"recent_topic_ids": [], "topic_counts": {}}
    try:
        with open(TOPIC_HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"recent_topic_ids": [], "topic_counts": {}}


def pick_next_topic(category_id: Optional[str] = None) -> Dict[str, str]:
    """
    指定されたカテゴリ、または直近使われていないカテゴリから次の話題を選出・履歴記録
    """
    history = load_topic_history()
    recent_ids = history.get("recent_topic_ids", [])
    counts = history.get("topic_counts", {})

    # 特定のカテゴリが指定された場合
    if category_id:
        target = next((c for c in INTERVIEW_TOPIC_CATEGORIES if c["id"] == category_id), None)
        if target:
            selected = target
        else:
            selected = random.choice(INTERVIEW_TOPIC_CATEGORIES)
    else:
        # 直近6回で使われていない候補を抽出（ループを防止）
        excluded_ids = set(recent_ids[-6:]) if len(recent_ids) >= 6 else set(recent_ids)
        candidates = [c for c in INTERVIEW_TOPIC_CATEGORIES if c["id"] not in excluded_ids]
        if not candidates:
            candidates = INTERVIEW_TOPIC_CATEGORIES

        # 使用回数が少ないものを優先、同数ならランダム
        candidates_sorted = sorted(candidates, key=lambda c: (counts.get(c["id"], 0), random.random()))
        selected = candidates_sorted[0]

    # 履歴を更新（直近15件を保持）
    recent_ids.append(selected["id"])
    if len(recent_ids) > 15:
        recent_ids = recent_ids[-15:]
    history["recent_topic_ids"] = recent_ids
    history["topic_counts"][selected["id"]] = counts.get(selected["id"], 0) + 1

    try:
        with open(TOPIC_HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[WARN] トピック履歴保存失敗: {e}")

    return selected


def get_line_credentials() -> tuple[Optional[str], Optional[str]]:
    """LINEのチャネルシークレットとアクセストークンを取得"""
    secret = os.getenv("LINE_CHANNEL_SECRET")
    token = os.getenv("LINE_CHANNEL_ACCESS_TOKEN")
    return (secret.strip() if secret else None, token.strip() if token else None)


def verify_line_signature(body_bytes: bytes, signature: str, channel_secret: str) -> bool:
    """LINE Webhook の X-Line-Signature 署名を検証"""
    if not signature or not channel_secret:
        return False
    hash_val = hmac.new(
        channel_secret.encode("utf-8"),
        body_bytes,
        hashlib.sha256,
    ).digest()
    expected_signature = base64.b64encode(hash_val).decode("utf-8")
    return hmac.compare_digest(expected_signature, signature)


def load_line_logs() -> List[Dict[str, Any]]:
    """保存されたLINE会話ログを読み込む"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not LOGS_FILE.exists():
        return []
    try:
        with open(LOGS_FILE, "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception as e:
        print(f"[WARN] LINEログ読み込み失敗: {e}")
        return []


def save_line_log(user_id: str, user_text: str, ai_reply: str) -> Dict[str, Any]:
    """1往復の会話ログを保存（表示不能文字・サロゲートを安全にサニタイズ）"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    clean_user_text = sanitize_line_text(user_text)
    clean_ai_reply = sanitize_line_text(ai_reply)

    with _logs_lock:
        logs = load_line_logs()
        item = {
            "id": f"log_{int(time.time() * 1000)}",
            "user_id": user_id,
            "timestamp": datetime.now().isoformat(),
            "user_message": clean_user_text,
            "ai_reply": clean_ai_reply,
            "learned": False,
        }
        logs.append(item)
        with open(LOGS_FILE, "w", encoding="utf-8", errors="replace") as f:
            json.dump(logs, f, ensure_ascii=False, indent=2)
        return item


def mark_logs_learned(log_ids: List[str]) -> None:
    """指定されたログを学習済みとしてマーク"""
    with _logs_lock:
        logs = load_line_logs()
        id_set = set(log_ids)
        for it in logs:
            if it.get("id") in id_set:
                it["learned"] = True
        with open(LOGS_FILE, "w", encoding="utf-8", errors="replace") as f:
            json.dump(logs, f, ensure_ascii=False, indent=2)


def reply_line_message(reply_token: str, reply_text: str, access_token: str) -> bool:
    """LINE Messaging API の reply エンドポイントにメッセージを送信"""
    url = "https://api.line.me/v2/bot/message/reply"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {access_token}",
    }
    payload = {
        "replyToken": reply_token,
        "messages": [
            {
                "type": "text",
                "text": reply_text,
            }
        ],
    }
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(url, headers=headers, json=payload)
            if not resp.is_success:
                print(f"[ERROR] LINE返信失敗 ({resp.status_code}): {resp.text}")
                return False
            return True
    except Exception as e:
        print(f"[ERROR] LINE返信例外: {e}")
        return False


USERS_FILE = DATA_DIR / "line_users.json"


def save_line_user(user_id: str) -> None:
    """メッセージを受信したLINEユーザーを記録"""
    if not user_id or user_id == "unknown_user":
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _logs_lock:
        users = []
        if USERS_FILE.exists():
            try:
                with open(USERS_FILE, "r", encoding="utf-8") as f:
                    users = json.load(f)
            except Exception:
                users = []
        if user_id not in users:
            users.append(user_id)
            with open(USERS_FILE, "w", encoding="utf-8") as f:
                json.dump(users, f, ensure_ascii=False, indent=2)


def get_active_line_users() -> List[str]:
    """登録されているLINEユーザー一覧を取得"""
    if not USERS_FILE.exists():
        # 会話ログからも復元
        logs = load_line_logs()
        u_set = {l.get("user_id") for l in logs if l.get("user_id") and l.get("user_id") != "unknown_user"}
        return list(u_set)
    try:
        with open(USERS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def push_line_message(user_id: str, text: str, access_token: str) -> bool:
    """LINE Messaging API の push エンドポイントで自発的にメッセージを送信"""
    url = "https://api.me.line.v2/bot/message/push"  # 後で https://api.line.me/v2/bot/message/push に修正
    url = "https://api.line.me/v2/bot/message/push"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {access_token}",
    }
    payload = {
        "to": user_id,
        "messages": [
            {
                "type": "text",
                "text": text,
            }
        ],
    }
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(url, headers=headers, json=payload)
            if not resp.is_success:
                print(f"[ERROR] LINE プッシュ送信失敗 ({resp.status_code}): {resp.text}")
                return False
            print(f"[LINE プッシュ成功] {user_id} 宛: \"{text}\"", flush=True)
            return True
    except Exception as e:
        print(f"[ERROR] LINE プッシュ送信例外: {e}")
        return False


def generate_proactive_question(
    gemini_api_key: str,
    user_id: Optional[str] = None,
    category_id: Optional[str] = None,
) -> str:
    """
    現在のpersona.txtと過去の会話ログを分析し、
    定期的に異なる話題カテゴリを選んで新鮮な質問文を生成する
    """
    from google import genai
    from google.genai import types

    # 話題カテゴリを決定（ローテーションまたは指定）
    topic = pick_next_topic(category_id)
    topic_name = topic["name"]
    topic_hints = topic["hints"]
    topic_sample = topic.get("sample", "最近どんなことあった？")

    # 現在のペルソナ情報
    current_persona = ""
    if PERSONA_FILE.exists():
        with open(PERSONA_FILE, "r", encoding="utf-8") as f:
            current_persona = f.read()

    # 直近の会話ログ
    logs = load_line_logs()
    if user_id:
        logs = [l for l in logs if l.get("user_id") == user_id]
    recent_logs_text = ""
    for l in logs[-12:]:
        recent_logs_text += f"拓さん: {l['user_message']}\nAI: {l['ai_reply']}\n"

    # 時間帯に応じた雰囲気づくり
    now_hour = datetime.now().hour
    time_hint = "日中"
    if 5 <= now_hour < 11:
        time_hint = "朝"
    elif 11 <= now_hour < 14:
        time_hint = "お昼休み"
    elif 17 <= now_hour < 20:
        time_hint = "夕方・帰宅時間"
    elif 20 <= now_hour <= 23:
        time_hint = "夜のリラックスタイム"

    prompt = (
        "あなたはユーザー（市川 拓さん）の『分身AI』を作るための、専属の相棒AIです。\n\n"
        "【すでに知っている拓さんの情報（persona.txt）】\n"
        f"{current_persona}\n\n"
        "【最近のLINE会話履歴】\n"
        f"{recent_logs_text if recent_logs_text else '（まだ会話履歴はありません）'}\n\n"
        f"【現在の時間帯】: {time_hint}（{now_hour}時頃）\n\n"
        f"【今回の質問テーマ（最重要）】\n"
        f"カテゴリ: 『{topic_name}』\n"
        f"着眼点・キーワード: {topic_hints}\n"
        f"質問のニュアンス例: {topic_sample}\n\n"
        "【あなたのタスク】\n"
        f"上記の『{topic_name}』のテーマに沿って、拓さんの本音や日常のエピソードを引き出す自然なLINE質問を1つ作成してください。\n"
        "友達としてLINEでふと思いついたように気さくに話しかけてください。\n\n"
        "【絶対ルール】\n"
        "1. 親しい友達のような気さくなタメ口（敬語は絶対に使わない）。\n"
        "2. 必ず1文〜2文（50文字以内）の超短文にすること。\n"
        "3. 絵文字やマークダウン記号は使わず、自然な話し言葉にすること。\n"
        "4. 直近の会話履歴ですでに話した話題（例: ラーメンやサウナ等で最近話したこと）とは被らないようにすること。\n"
        "5. 時間帯に合った自然な切り出し（『そういえば〜』『ふと思ったんだけど〜』『おつかれ！〜』など）にすること。\n"
        "6. 質問文そのものだけを出力してください。"
    )

    client = genai.Client(api_key=gemini_api_key)

    for model_name in ["gemini-3.5-flash-lite", "gemini-flash-latest"]:
        try:
            resp = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.88,
                    max_output_tokens=100,
                ),
            )
            if resp and resp.text:
                clean_q = resp.text.strip().replace("「", "").replace("」", "").replace('"', "")
                print(f"[PROACTIVE] カテゴリ【{topic_name}】から質問生成: \"{clean_q}\"", flush=True)
                return clean_q
        except Exception as e:
            print(f"[WARN] 自発質問生成リトライ ({model_name}): {e}")
            continue

    return topic_sample


def send_proactive_question_to_users(
    gemini_api_key: str,
    access_token: str,
    category_id: Optional[str] = None,
) -> Dict[str, Any]:
    """登録されているアクティブユーザー全員（または最新のユーザー）に自発的な質問を送信"""
    users = get_active_line_users()
    if not users:
        return {
            "success": False,
            "message": "まだLINEで話しかけてくれたユーザーがいません。一度本人のLINEからメッセージを受信すると送信先として記憶されます。",
            "sent_count": 0,
        }

    question = generate_proactive_question(gemini_api_key, category_id=category_id)
    sent_count = 0

    for uid in users:
        ok = push_line_message(uid, question, access_token)
        if ok:
            sent_count += 1
            # AIからの能動メッセージとしてログに保存
            save_line_log(uid, "（AIからの自発的な質問）", question)

    if sent_count > 0:
        return {
            "success": True,
            "message": f"拓さんのLINEに質問を送信しました！\n質問内容：「{question}」",
            "question": question,
            "sent_count": sent_count,
        }
    else:
        return {
            "success": False,
            "message": "LINEへのプッシュ送信に失敗しました。トークンを確認してください。",
            "sent_count": 0,
        }


def generate_interview_reply(user_message: str, user_id: str, gemini_api_key: str) -> str:
    """
    本人（市川拓さん）から自然にエピソードや口癖を引き出すインタビュー返信を生成。
    尋問のように無理に話題を切り替えるのではなく、自然な友達同士の雑談・リアクション・共感を優先し、
    話題が本当に尽きた場合のみ新しい角度から話を広げる。
    """
    from google import genai
    from google.genai import types

    # 直近の会話文脈を取得（最大8往復）
    logs = load_line_logs()
    user_recent_logs = [l for l in logs if l.get("user_id") == user_id][-8:]

    # 相手が明示的に話題を変えたがっているか、または同じ話題で長くラリーが続いたか
    wants_new_topic = any(
        kw in user_message for kw in ["別の話", "違う話", "他には", "話題変え", "飽きた", "それより", "関係ないけど"]
    )
    is_conversation_long = len(user_recent_logs) >= 6

    # 自然な対話プロンプトの構成
    if wants_new_topic or is_conversation_long:
        next_hint = pick_next_topic()
        transition_guide = (
            f"【話題の展開】\n"
            f"相手の返答を軽く受け止めた上で、自然に新しい日常の話題へ話を移してください。\n"
            f"ヒントテーマ: 『{next_hint['name']}』（着眼点: {next_hint['hints']}）などを参考に、\n"
            f"「そういえばさ〜」「話変わるんだけど〜」と気さくに友達らしく切り出してください。"
        )
    else:
        transition_guide = (
            "【会話の広げ方（最重要）】\n"
            "相手の発言に含まれる具体的な単語やエピソード（食べ物、店、場所、出来事、感想など）を拾って、"
            "まずは「共感・リアクション（『それな！』『わかるわー笑』『まじで？』など）」を返してください。\n"
            "その上で、相手がさらに喋りたくなるような自然な一言（『それのどこが好き？』『何倍にする派？』『いつ行ったの？』など）を軽く添えてください。\n"
            "※急に全然関係のない別の話題に飛ぶのは不自然なので絶対に避けてください。今の話題を楽しく広げてください。"
        )

    system_instruction = (
        "あなたはユーザー（市川 拓さん）の『分身AI』を作るための、専属の相棒・親しい友達です。\n\n"
        "【目的】\n"
        "友達同士のテンポ良い日常のLINE雑談を通じて、拓さんのリアルな「口癖」「リアクション」「こだわり」「エピソード」を引き出すこと。\n\n"
        "【対話ルール】\n"
        "1. 友達同士の気さくなタメ口（敬語は絶対に使わない）。\n"
        "2. 一方的なアンケートや尋問にならないように、まず相手の発言にしっかり共感・リアクションすること。\n"
        f"3. {transition_guide}\n"
        "4. テンポよく返せるよう、必ず1文〜2文（60文字以内）の短文にすること。\n"
        "5. 絵文字やマークダウン記号は使わず、自然な話し言葉（笑、〜じゃん、〜だわ、など）にすること。\n"
        "6. 説教、アドバイス、長い解説は一切不要です。"
    )

    contents = []
    for l in user_recent_logs:
        contents.append(types.Content(role="user", parts=[types.Part.from_text(text=l["user_message"])]))
        contents.append(types.Content(role="model", parts=[types.Part.from_text(text=l["ai_reply"])]))

    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=user_message)]))

    client = genai.Client(api_key=gemini_api_key)

    # 最速モデルで即座に返信
    for model_name in ["gemini-3.5-flash-lite", "gemini-flash-latest"]:
        try:
            resp = client.models.generate_content(
                model=model_name,
                contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    temperature=0.85,
                    max_output_tokens=120,
                ),
            )
            if resp and resp.text:
                return resp.text.strip()
        except Exception as e:
            print(f"[WARN] LINE返答生成リトライ ({model_name}): {e}")
            continue

    return "なるほどね！それって普段もよく行くの？"


def update_persona_from_logs(gemini_api_key: str) -> Dict[str, Any]:
    """
    未学習のLINE会話ログをGeminiで分析し、persona.txtを自動アップデートする
    """
    from google import genai
    from google.genai import types

    logs = load_line_logs()
    unlearned_logs = [l for l in logs if not l.get("learned", False)]

    if not unlearned_logs:
        return {
            "success": False,
            "message": "新しく学習する未処理の会話ログがありません。",
            "learned_count": 0,
        }

    # 現在のpersona.txtを読み込み
    current_persona = ""
    if PERSONA_FILE.exists():
        with open(PERSONA_FILE, "r", encoding="utf-8") as f:
            current_persona = f.read()

    # 会話ログの整形
    conversations_text = ""
    log_ids = []
    for l in unlearned_logs[-30:]:  # 一度に最大30件まで学習
        conversations_text += f"拓さん: {l['user_message']}\nAI: {l['ai_reply']}\n\n"
        log_ids.append(l["id"])

    instruction = (
        "あなたは人物プロファイリングとAIプロンプト設計の最高責任者です。\n"
        "以下は、対象人物（市川 拓さん）とAIが実際に行った最新のLINE対話ログです。\n\n"
        "【現在の persona.txt】\n"
        f"{current_persona}\n\n"
        "【新たに収集された本人のLINE会話ログ】\n"
        f"{conversations_text}\n\n"
        "【指示】\n"
        "1. 新たな会話ログから、拓さん本人の「リアルな口癖」「新たに出たエピソードや好み」「リアクションの傾向」を抽出してください。\n"
        "2. 現在の persona.txt の構造とルール（TTS用短文ルールなど）を壊さずに、新しいエピソードや会話例（Few-shot）を自然に追記・洗練してください。\n"
        "3. 出力は、更新後の persona.txt の全文テキストのみを出力してください（余計な解説文やマークダウンコードブロック ``` は不要です）。"
    )

    client = genai.Client(api_key=gemini_api_key)
    updated_persona_text = ""

    for model_name in ["gemini-3.5-flash-lite", "gemini-flash-latest"]:
        try:
            resp = client.models.generate_content(
                model=model_name,
                contents=instruction,
                config=types.GenerateContentConfig(
                    temperature=0.4,
                    max_output_tokens=3000,
                ),
            )
            if resp and resp.text:
                updated_persona_text = resp.text.strip()
                break
        except Exception as e:
            print(f"[WARN] persona更新生成失敗 ({model_name}): {e}")
            continue

    if not updated_persona_text:
        return {
            "success": False,
            "message": "Gemini による persona の更新テキスト生成に失敗しました。",
            "learned_count": 0,
        }

    # コードブロック記号などをトリミング
    if updated_persona_text.startswith("```"):
        lines = updated_persona_text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        updated_persona_text = "\n".join(lines).strip()

    # 表示不能文字・サロゲートをサニタイズ
    updated_persona_text = sanitize_line_text(updated_persona_text)

    # persona.txt に書き込み保存（errors="replace" でUnicode例外を完全防止）
    with open(PERSONA_FILE, "w", encoding="utf-8", errors="replace") as f:
        f.write(updated_persona_text)

    # ログを学習済みに更新
    mark_logs_learned(log_ids)

    return {
        "success": True,
        "message": f"新たに {len(log_ids)} 件のLINE会話ログを学習し、persona.txt を自動更新しました！",
        "learned_count": len(log_ids),
        "updated_persona": updated_persona_text,
    }


_last_proactive_time: float = 0.0


def should_auto_proactive() -> bool:
    """自動自発質問を送信すべきタイミングか判定（営業時間内＆4時間以上経過）"""
    global _last_proactive_time
    now = datetime.now()
    # 深夜早朝 (23:00〜8:00) は送信しない
    if now.hour < 8 or now.hour >= 23:
        return False
    # 前回の自発質問から4時間以上空ける
    if time.time() - _last_proactive_time < 4 * 3600:
        return False
    # 直近の会話ログを確認（相手が話してから2時間以内の場合はまだ話しかけない）
    logs = load_line_logs()
    if logs:
        last_log = logs[-1]
        try:
            last_dt = datetime.fromisoformat(last_log["timestamp"])
            elapsed_sec = (now - last_dt).total_seconds()
            if elapsed_sec < 3600 * 2:
                return False
        except Exception:
            pass
    return True


def start_proactive_scheduler(gemini_api_key: str, access_token: str, check_interval_sec: int = 1800) -> None:
    """定期的に能動質問チェックを行うバックグラウンドワーカースレッドを起動"""
    def worker():
        global _last_proactive_time
        print("[PROACTIVE] LINE自発インタビュー定期監視スレッドを開始しました", flush=True)
        # 起動直後は5分待ってから定期チェック
        time.sleep(300)
        while True:
            try:
                if should_auto_proactive():
                    print("[PROACTIVE] 自発質問の自動送信条件を満たしました。Geminiで質問を生成します...", flush=True)
                    res = send_proactive_question_to_users(gemini_api_key, access_token)
                    if res.get("success"):
                        _last_proactive_time = time.time()
                    print(f"[PROACTIVE] 送信結果: {res.get('message')}", flush=True)
            except Exception as e:
                print(f"[WARN] 自発質問スケジューラー例外: {e}", flush=True)
            time.sleep(check_interval_sec)

    t = threading.Thread(target=worker, daemon=True)
    t.start()


def import_line_chat_history(raw_text: str, gemini_api_key: str, auto_learn: bool = True) -> Dict[str, Any]:
    """
    LINE Official Account Managerのチャット欄コピペやトーク履歴テキストをGeminiで構造化抽出し、
    会話ログとして保存＆persona.txtに自動学習させる（DB管理不要）
    """
    from google import genai
    from google.genai import types

    # 1. 表示不能文字・サロゲートペア・制御文字・外字をサニタイズ
    raw_text = sanitize_line_text(raw_text)
    if not raw_text:
        return {"success": False, "message": "テキストが空、または有効な文字が含まれていません。", "imported_count": 0}

    # 生ログのバックアップ保存（errors="replace" で文字コード例外を完全に防止）
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    raw_backup_file = DATA_DIR / "line_imported_raw.txt"
    try:
        with open(raw_backup_file, "a", encoding="utf-8", errors="replace") as f:
            f.write(f"\n--- インポート日時: {datetime.now().isoformat()} ---\n{raw_text}\n")
    except Exception as e:
        print(f"[WARN] バックアップ書き込み失敗: {e}")

    # Geminiで構造化抽出
    instruction = (
        "あなたはLINEのチャット画面テキストやトーク履歴を解析・構造化する専門アシスタントです。\n"
        "以下に、LINE公式アカウント管理画面のチャット欄をコピーしたテキスト、またはエクスポートされたトーク履歴テキストが渡されます。\n\n"
        "【入力テキスト】\n"
        f"{raw_text[:15000]}\n\n"
        "【タスク】\n"
        "このテキストから、市川拓さん（本人）の発言と、相手（AI、友達、ボットなど）の発言のやり取り（1往復ごと）を抽出してください。\n"
        "もし相手の発言がない場合や本人の一方的な発言・メモの場合は、ai_reply を「（LINEトーク履歴より記録）」としてください。\n\n"
        "【出力ルール】\n"
        "・必ず有効なJSON配列（リスト）のみを出力してください。\n"
        "・マークダウン記法（```json など）は付けずに純粋なJSON文字列で出力してください。\n"
        "・フォーマット例:\n"
        "[\n"
        '  {"user_message": "本人の発言内容", "ai_reply": "相手の発言内容", "timestamp": "2024-10-27T10:00:00"}\n'
        "]"
    )

    client = genai.Client(api_key=gemini_api_key)
    json_text = ""

    for model_name in ["gemini-3.5-flash-lite", "gemini-flash-latest"]:
        try:
            resp = client.models.generate_content(
                model=model_name,
                contents=instruction,
                config=types.GenerateContentConfig(
                    temperature=0.2,
                    max_output_tokens=4000,
                ),
            )
            if resp and resp.text:
                json_text = resp.text.strip()
                break
        except Exception as e:
            print(f"[WARN] チャット解析生成失敗 ({model_name}): {e}")
            continue

    # JSONパース（制御文字・マークダウン・エスケープ不備に完全対応した安全パーサーを使用）
    parsed_items = parse_chat_json_safely(json_text, original_raw_text=raw_text)

    if not parsed_items:
        return {"success": False, "message": "会話データが見つかりませんでした。テキストの内容（送信者名やメッセージ）を確認してください。", "imported_count": 0}

    # ログを蓄積
    imported_count = 0
    with _logs_lock:
        existing_logs = load_line_logs()
        now_iso = datetime.now().isoformat()
        for idx, item in enumerate(parsed_items):
            u_msg = sanitize_line_text(str(item.get("user_message", "")))
            a_msg = sanitize_line_text(str(item.get("ai_reply", "（LINEトーク履歴より記録）")))
            ts = item.get("timestamp") or now_iso
            if not u_msg:
                continue
            log_item = {
                "id": f"import_{int(time.time() * 1000)}_{idx}",
                "user_id": "line_chat_import",
                "timestamp": ts,
                "user_message": u_msg,
                "ai_reply": a_msg,
                "learned": False,
            }
            existing_logs.append(log_item)
            imported_count += 1

        with open(LOGS_FILE, "w", encoding="utf-8", errors="replace") as f:
            json.dump(existing_logs, f, ensure_ascii=False, indent=2)

    # 自動学習（persona.txt の更新）
    learn_msg = ""
    if auto_learn and imported_count > 0:
        learn_res = update_persona_from_logs(gemini_api_key)
        learn_msg = learn_res.get("message", "")

    return {
        "success": True,
        "message": f"{imported_count} 件の会話ログをチャット履歴から取り込みました！" + (f"\n{learn_msg}" if learn_msg else ""),
        "imported_count": imported_count,
        "learned": auto_learn,
    }


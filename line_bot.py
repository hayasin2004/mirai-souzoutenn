"""
LINE Bot 連携 & 会話ログ蓄積・AI人格学習モジュール
"""

import base64
import hashlib
import hmac
import json
import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
LOGS_FILE = DATA_DIR / "line_logs.json"
PERSONA_FILE = BASE_DIR / "persona.txt"

load_dotenv(BASE_DIR / ".env")

_logs_lock = threading.Lock()


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
        with open(LOGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception as e:
        print(f"[WARN] LINEログ読み込み失敗: {e}")
        return []


def save_line_log(user_id: str, user_text: str, ai_reply: str) -> Dict[str, Any]:
    """1往復の会話ログを保存"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _logs_lock:
        logs = load_line_logs()
        item = {
            "id": f"log_{int(time.time() * 1000)}",
            "user_id": user_id,
            "timestamp": datetime.now().isoformat(),
            "user_message": user_text,
            "ai_reply": ai_reply,
            "learned": False,
        }
        logs.append(item)
        with open(LOGS_FILE, "w", encoding="utf-8") as f:
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
        with open(LOGS_FILE, "w", encoding="utf-8") as f:
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


def generate_interview_reply(user_message: str, user_id: str, gemini_api_key: str) -> str:
    """
    本人（市川拓さん）から自然にエピソードや口癖を引き出すインタビュー返信を生成
    """
    from google import genai
    from google.genai import types

    # 直近の会話文脈を取得
    logs = load_line_logs()
    user_recent_logs = [l for l in logs if l.get("user_id") == user_id][-4:]

    client = genai.Client(api_key=gemini_api_key)

    system_instruction = (
        "あなたはユーザー（市川 拓さん）の『分身AI』を作るための、親しみやすい相棒・専属インタビュアーです。\n"
        "【目的】\n"
        "ユーザーとの自然な日常会話を通じて、本人の「口癖」「価値観」「日常のエピソード」「好きなことの具体的な話」を引き出すこと。\n\n"
        "【対話ルール】\n"
        "1. 気さくな友達のように、フランクなタメ口で話してください（敬語は不要）。\n"
        "2. 相手の発言を肯定・共感しつつ、「それって普段もよく行くの？」「どんなところが好き？」「他には？」など、"
        "自然に話を広げる一言質問を添えてください。\n"
        "3. テンポよく返せるよう、必ず1文〜2文（60文字以内）の短文で返信してください。\n"
        "4. 説教やアドバイスは不要です。相手に気持ちよく喋らせる聞き役に徹してください。"
    )

    contents = []
    for l in user_recent_logs:
        contents.append(types.Content(role="user", parts=[types.Part.from_text(text=l["user_message"])]))
        contents.append(types.Content(role="model", parts=[types.Part.from_text(text=l["ai_reply"])]))

    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=user_message)]))

    # 最速モデルで即座に返信
    for model_name in ["gemini-3.5-flash-lite", "gemini-flash-latest"]:
        try:
            resp = client.models.generate_content(
                model=model_name,
                contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    temperature=0.8,
                    max_output_tokens=120,
                ),
            )
            if resp and resp.text:
                return resp.text.strip()
        except Exception as e:
            print(f"[WARN] LINE返答生成リトライ ({model_name}): {e}")
            continue

    return "なるほどね！もっと詳しく教えてほしいな。"


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

    # persona.txt に書き込み保存
    with open(PERSONA_FILE, "w", encoding="utf-8") as f:
        f.write(updated_persona_text)

    # ログを学習済みに更新
    mark_logs_learned(log_ids)

    return {
        "success": True,
        "message": f"新たに {len(log_ids)} 件のLINE会話ログを学習し、persona.txt を自動更新しました！",
        "learned_count": len(log_ids),
        "updated_persona": updated_persona_text,
    }

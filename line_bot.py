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


def generate_proactive_question(gemini_api_key: str, user_id: Optional[str] = None) -> str:
    """
    現在のpersona.txtと過去の会話ログを分析し、「まだ知らないこと」「もっと深く知りたいこと」を自発的に尋ねる質問文を生成
    """
    from google import genai
    from google.genai import types

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
        "【あなたのタスク】\n"
        "拓さんについて『まだ詳しくわかっていないこと』や『もっと深掘りしたいエピソード（日頃のこだわり、最近あったこと、好きなものの細かい話、人間関係、口癖、価値観など）』を1つ見つけてください。\n"
        "友達としてLINEでふと思いついたように話しかける、自然な質問メッセージを作成してください。\n\n"
        "【ルール】\n"
        "1. 親しい友達のような気さくなタメ口（敬語は絶対に使わない）。\n"
        "2. 必ず1文〜2文（50文字以内）の超短文にすること。\n"
        "3. 絵文字やマークダウン記号は使わず、自然な話し言葉にすること。\n"
        "4. 時間帯に合った自然な切り出し（『そういえば〜』『ふと思ったんだけど〜』『おつかれ！〜』など）にすること。\n"
        "5. 質問文そのものだけを出力してください。"
    )

    client = genai.Client(api_key=gemini_api_key)

    for model_name in ["gemini-3.5-flash-lite", "gemini-flash-latest"]:
        try:
            resp = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.85,
                    max_output_tokens=100,
                ),
            )
            if resp and resp.text:
                clean_q = resp.text.strip().replace("「", "").replace("」", "").replace('"', "")
                return clean_q
        except Exception as e:
            print(f"[WARN] 自発質問生成リトライ ({model_name}): {e}")
            continue

    return "そういえば拓さん、休みの日はいつも何時くらいに起きてるの？"


def send_proactive_question_to_users(gemini_api_key: str, access_token: str) -> Dict[str, Any]:
    """登録されているアクティブユーザー全員（または最新のユーザー）に自発的な質問を送信"""
    users = get_active_line_users()
    if not users:
        return {
            "success": False,
            "message": "まだLINEで話しかけてくれたユーザーがいません。一度本人のLINEからメッセージを受信すると送信先として記憶されます。",
            "sent_count": 0,
        }

    question = generate_proactive_question(gemini_api_key)
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
            "message": f"拓さんのLINEに自発的な質問を送信しました！\n質問内容：「{question}」",
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

    raw_text = raw_text.strip()
    if not raw_text:
        return {"success": False, "message": "テキストが空です。", "imported_count": 0}

    # 生ログのバックアップ保存
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    raw_backup_file = DATA_DIR / "line_imported_raw.txt"
    try:
        with open(raw_backup_file, "a", encoding="utf-8") as f:
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

    if not json_text:
        return {"success": False, "message": "Geminiによるチャットテキストの解析に失敗しました。", "imported_count": 0}

    # JSONパース（```json などのコードブロックが含まれていた場合は除去）
    if json_text.startswith("```"):
        lines = json_text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        json_text = "\n".join(lines).strip()

    try:
        parsed_items = json.loads(json_text)
        if not isinstance(parsed_items, list):
            parsed_items = [parsed_items]
    except Exception as e:
        print(f"[ERROR] JSONデコード失敗: {e}\n{json_text}")
        return {"success": False, "message": f"会話データの抽出形式エラー: {e}", "imported_count": 0}

    if not parsed_items:
        return {"success": False, "message": "会話データが見つかりませんでした。テキストの内容を確認してください。", "imported_count": 0}

    # ログを蓄積
    imported_count = 0
    with _logs_lock:
        existing_logs = load_line_logs()
        now_iso = datetime.now().isoformat()
        for idx, item in enumerate(parsed_items):
            u_msg = str(item.get("user_message", "")).strip()
            a_msg = str(item.get("ai_reply", "（LINEトーク履歴より記録）")).strip()
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

        with open(LOGS_FILE, "w", encoding="utf-8") as f:
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


"""
マルチペルソナ管理モジュール
複数人のAI（市川拓、および他の人物）の人格テキスト・メタ情報・LINEユーザー紐付けを管理する
"""

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent
PERSONAS_DIR = BASE_DIR / "personas"
LEGACY_PERSONA_FILE = BASE_DIR / "persona.txt"
DATA_DIR = BASE_DIR / "data"
USER_PERSONA_MAP_FILE = DATA_DIR / "line_user_personas.json"

# デフォルトのペルソナテンプレート
DEFAULT_TEMPLATE = """あなたは「{name}（{nickname}）」のデジタルの分身です。
以下のプロフィール、性格、口調、および会話例を忠実に再現し、相手と自然な会話を行ってください。

【1. 基本プロフィール】
・名前: {name}（呼ばれ方: {nickname}）
・属性: {attribute}
・性格: {personality}
・大事にしていること: 楽しむこと、無理をしないこと、仲間。

【2. 知識と記憶】
・好きなこと: {favorites}
・苦手なこと: {dislikes}

【3. 会話とリアクションのルール】
・一人称: 「{first_person}」
・二人称: 「〇〇君」「〇〇さん」「名前呼び捨て」
・テンション: 自然な日常会話。基本は聞き役だが気さくに返す。
・よく使う口癖: 「確かに」「まあね」「なるほど」

【4. 音声読み上げ（TTS）のための絶対ルール】※最重要
1. 絵文字や顔文字は絶対に使用しないでください。
2. マークダウン記号は一切使わず、通常の話し言葉テキストのみで出力してください。
3. 返答は1〜2文（50文字〜80文字以内）で、テンポよく簡潔に話してください。

【5. AIとしての制約事項】
・丁寧すぎる敬語は使わず、親しい友達のような自然な口調にすること。
・本人が言っていない思い出を勝手に作らないこと。
"""


def ensure_personas_dir() -> None:
    """personasディレクトリを準備し、既存のpersona.txtがあればtakuとして移行"""
    PERSONAS_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    taku_dir = PERSONAS_DIR / "taku"
    if not taku_dir.exists():
        taku_dir.mkdir(parents=True, exist_ok=True)
        taku_meta = {
            "id": "taku",
            "name": "市川 拓",
            "nickname": "たく",
            "attribute": "20代前半の専門学生。高度情報学科でプログラミングを学習中。",
            "voice_name": "tako",
            "created_at": datetime.now().isoformat(),
        }
        with open(taku_dir / "meta.json", "w", encoding="utf-8") as f:
            json.dump(taku_meta, f, ensure_ascii=False, indent=2)

        # 既存のpersona.txtがあればコピー、なければテンプレート
        if LEGACY_PERSONA_FILE.exists():
            content = LEGACY_PERSONA_FILE.read_text(encoding="utf-8")
        else:
            content = DEFAULT_TEMPLATE.format(
                name="市川 拓",
                nickname="たく",
                attribute="20代前半の専門学生。高度情報学科でプログラミングを学習中。",
                personality="好奇心旺盛、マイペース、基本ポジティブ。",
                favorites="サウナ、ラーメン巡り、にゃんこ大戦争、バスケ",
                dislikes="早起き、人混み",
                first_person="俺",
            )
        (taku_dir / "persona.txt").write_text(content, encoding="utf-8")


def list_personas() -> List[Dict[str, Any]]:
    """登録されているすべてのペルソナの一覧を取得"""
    ensure_personas_dir()
    personas = []
    for p_dir in PERSONAS_DIR.iterdir():
        if p_dir.is_dir() and (p_dir / "persona.txt").exists():
            meta = {}
            meta_file = p_dir / "meta.json"
            if meta_file.exists():
                try:
                    with open(meta_file, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                except Exception:
                    pass

            p_id = p_dir.name
            personas.append({
                "id": p_id,
                "name": meta.get("name", p_id),
                "nickname": meta.get("nickname", meta.get("name", p_id)),
                "attribute": meta.get("attribute", ""),
                "voice_name": meta.get("voice_name", ""),
                "created_at": meta.get("created_at", ""),
            })

    # takuを先頭にする
    personas.sort(key=lambda p: (0 if p["id"] == "taku" else 1, p["id"]))
    return personas


def get_persona(person_id: str = "taku") -> Optional[Dict[str, Any]]:
    """指定されたIDのペルソナ情報（メタデータ ＋ 本文テキスト）を取得"""
    ensure_personas_dir()
    target_dir = PERSONAS_DIR / person_id
    if not target_dir.exists() or not (target_dir / "persona.txt").exists():
        if person_id == "taku" and LEGACY_PERSONA_FILE.exists():
            # フォールバック
            return {
                "id": "taku",
                "name": "市川 拓",
                "nickname": "たく",
                "content": LEGACY_PERSONA_FILE.read_text(encoding="utf-8"),
                "voice_name": "tako",
            }
        return None

    meta = {}
    meta_file = target_dir / "meta.json"
    if meta_file.exists():
        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            pass

    content = (target_dir / "persona.txt").read_text(encoding="utf-8")
    return {
        "id": person_id,
        "name": meta.get("name", person_id),
        "nickname": meta.get("nickname", meta.get("name", person_id)),
        "attribute": meta.get("attribute", ""),
        "voice_name": meta.get("voice_name", ""),
        "created_at": meta.get("created_at", ""),
        "content": content,
    }


def save_persona_text(person_id: str, text: str) -> bool:
    """指定されたペルソナのpersona.txtを保存（表示不能文字のエンコード例外を防止）"""
    ensure_personas_dir()
    target_dir = PERSONAS_DIR / person_id
    target_dir.mkdir(parents=True, exist_ok=True)
    (target_dir / "persona.txt").write_text(text, encoding="utf-8", errors="replace")

    # もしtakuならレガシーpersona.txtとも同期
    if person_id == "taku":
        try:
            LEGACY_PERSONA_FILE.write_text(text, encoding="utf-8", errors="replace")
        except Exception:
            pass
    return True


def create_persona(
    person_id: str,
    name: str,
    nickname: Optional[str] = None,
    attribute: str = "",
    personality: str = "",
    favorites: str = "",
    dislikes: str = "",
    first_person: str = "私",
    voice_name: str = "",
    initial_content: Optional[str] = None,
) -> Dict[str, Any]:
    """新規ペルソナを作成"""
    ensure_personas_dir()
    # IDのサニタイズ（英数字とアンダースコア）
    clean_id = re.sub(r"[^a-zA-Z0-9_\-]", "", person_id).lower()
    if not clean_id:
        clean_id = f"person_{int(datetime.now().timestamp())}"

    target_dir = PERSONAS_DIR / clean_id
    if target_dir.exists():
        raise ValueError(f"ペルソナID '{clean_id}' はすでに存在します。")

    target_dir.mkdir(parents=True, exist_ok=True)

    nick = nickname if nickname else name
    meta = {
        "id": clean_id,
        "name": name,
        "nickname": nick,
        "attribute": attribute,
        "voice_name": voice_name,
        "created_at": datetime.now().isoformat(),
    }
    with open(target_dir / "meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    if initial_content and initial_content.strip():
        content = initial_content.strip()
    else:
        content = DEFAULT_TEMPLATE.format(
            name=name,
            nickname=nick,
            attribute=attribute if attribute else "未設定",
            personality=personality if personality else "気さくで親しみやすい",
            favorites=favorites if favorites else "いろいろ",
            dislikes=dislikes if dislikes else "特になし",
            first_person=first_person if first_person else "私",
        )

    (target_dir / "persona.txt").write_text(content, encoding="utf-8")
    return {
        "id": clean_id,
        "name": name,
        "nickname": nick,
        "voice_name": voice_name,
        "content": content,
    }


def delete_persona(person_id: str) -> bool:
    """指定されたペルソナを削除（takuは削除不可）"""
    if person_id == "taku":
        raise ValueError("デフォルトのペルソナ (taku) は削除できません。")
    target_dir = PERSONAS_DIR / person_id
    if not target_dir.exists():
        return False
    import shutil
    shutil.rmtree(target_dir)
    return True


# LINEユーザーIDとペルソナの紐付け管理
def load_line_user_persona_map() -> Dict[str, str]:
    """LINEユーザーID -> ペルソナIDのマップを読み込む"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not USER_PERSONA_MAP_FILE.exists():
        return {}
    try:
        with open(USER_PERSONA_MAP_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def bind_line_user_to_persona(user_id: str, person_id: str) -> None:
    """LINEユーザーを指定ペルソナに紐付け"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    mapping = load_line_user_persona_map()
    mapping[user_id] = person_id
    with open(USER_PERSONA_MAP_FILE, "w", encoding="utf-8") as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)


def get_persona_id_for_line_user(user_id: Optional[str]) -> str:
    """LINEユーザーIDに対応するペルソナIDを取得（未登録ならデフォルトtaku）"""
    if not user_id:
        return "taku"
    mapping = load_line_user_persona_map()
    return mapping.get(user_id, "taku")

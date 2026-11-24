"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  // ナビ & バッジ
  tabChat: $("tab-chat"),
  tabTts: $("tab-tts"),
  panelChat: $("panel-chat"),
  panelTts: $("panel-tts"),
  modelBadge: $("model-badge"),
  geminiBadge: $("gemini-badge"),
  personaBtn: $("persona-btn"),

  // 共通コントロール
  voice: $("voice-select"),
  speed: $("speed-range"),
  speedValue: $("speed-value"),

  // チャット
  chatMessages: $("chat-messages"),
  chatInput: $("chat-input"),
  sendChatBtn: $("send-chat-btn"),
  micBtn: $("mic-btn"),
  autoSendVoiceToggle: $("auto-send-voice-toggle"),
  llmProviderSelect: $("llm-provider-select"),
  localModelSelect: $("local-model-select"),
  ttsProviderSelect: $("tts-provider-select"),
  enableTtsToggle: $("enable-tts-toggle"),
  enableAvatarVideoToggle: $("enable-avatar-video-toggle"),

  // アバター映像連携
  openAvatarWinBtn: $("open-avatar-win-btn"),
  popoutAvatarBtn: $("popout-avatar-btn"),
  toggleChatOnlyBtn: $("toggle-chat-only-btn"),
  avatarSourceSelect: $("avatar-source-select"),
  avatarUploadInput: $("avatar-upload-input"),
  mainAvatarImg: $("main-avatar-img"),
  mainAvatarIdleVideo: $("main-avatar-idle-video"),
  mainAvatarVideo: $("main-avatar-video"),
  avatarGenBadge: $("avatar-gen-badge"),

  // TTS読み上げ
  ttsText: $("tts-text"),
  charCount: $("char-count"),
  speakBtn: $("speak-btn"),

  // プレイヤー & 波形
  audio: $("audio"),
  canvas: $("visualizer"),
  nowPlaying: $("now-playing"),
  playBtn: $("play-btn"),
  seek: $("seek-range"),
  timeCurrent: $("time-current"),
  timeTotal: $("time-total"),
  download: $("download-link"),

  // 履歴
  historyList: $("history-list"),
  clearHistory: $("clear-history-btn"),

  // 人格モーダル & ペルソナ切替
  personaBtn: $("persona-btn"),
  personaSelect: $("persona-select"),
  addPersonaBtn: $("add-persona-btn"),
  lineCurrentPersonaName: $("line-current-persona-name"),
  dialog: $("persona-dialog"),
  closeDialogBtn: $("close-dialog-btn"),
  personaTextarea: $("persona-textarea"),
  savePersonaBtn: $("save-persona-btn"),
  personaStatus: $("persona-status"),

  // 新規人物AI作成モーダル
  newPersonaDialog: $("new-persona-dialog"),
  closeNewPersonaBtn: $("close-new-persona-btn"),
  formNewPersona: $("form-new-persona"),
  npName: $("np-name"),
  npNickname: $("np-nickname"),
  npId: $("np-id"),
  npFirstPerson: $("np-first-person"),
  npAttribute: $("np-attribute"),
  npPersonality: $("np-personality"),
  npFavorites: $("np-favorites"),
  npVoiceSelect: $("np-voice-select"),
  npStatus: $("np-status"),
  submitNewPersonaBtn: $("submit-new-persona-btn"),

  // LINE育成
  tabLine: $("tab-line"),
  panelLine: $("panel-line"),
  lineBadge: $("line-badge"),
  lineConfigStatus: $("line-config-status"),
  lineTotalCount: $("line-total-count"),
  lineUnlearnedCount: $("line-unlearned-count"),
  lineUsersCount: $("line-users-count"),
  lineTopicSelect: $("line-topic-select"),
  lineProactiveBtn: $("line-proactive-btn"),
  lineLearnBtn: $("line-learn-btn"),
  lineRefreshBtn: $("line-refresh-btn"),
  webhookUrlCode: $("webhook-url-code"),
  copyWebhookBtn: $("copy-webhook-btn"),
  lineLogsList: $("line-logs-list"),
  lineLogsBadge: $("line-logs-badge"),
  lineCurrentPersonaName: $("line-current-persona-name"),
  setLineActivePersonaBtn: $("set-line-active-persona-btn"),
  lineActivePersonaBadge: $("line-active-persona-badge"),

  // LINEチャット履歴インポート
  lineImportText: $("line-import-text"),
  lineImportFile: $("line-import-file"),
  lineImportFilename: $("line-import-filename"),
  lineImportBtn: $("line-import-btn"),
  lineImportStatus: $("line-import-status"),

  // 声管理モーダル
  manageVoicesBtn: $("manage-voices-btn"),
  voiceDialog: $("voice-dialog"),
  closeVoiceDialogBtn: $("close-voice-dialog-btn"),
  voiceManageList: $("voice-manage-list"),
  vtabUpload: $("vtab-upload"),
  vtabId: $("vtab-id"),
  formCloneAudio: $("form-clone-audio"),
  formLinkId: $("form-link-id"),
  cloneVoiceName: $("clone-voice-name"),
  cloneAudioFile: $("clone-audio-file"),
  cloneRefText: $("clone-ref-text"),
  cloneAvatarSelect: $("clone-avatar-select"),
  cloneAvatarFile: $("clone-avatar-file"),
  submitCloneBtn: $("submit-clone-btn"),
  cloneStatus: $("clone-status"),
  linkVoiceName: $("link-voice-name"),
  linkVoiceId: $("link-voice-id"),
  linkAvatarSelect: $("link-avatar-select"),
  linkAvatarFile: $("link-avatar-file"),
  submitLinkBtn: $("submit-link-btn"),
  linkStatus: $("link-status"),

  toast: $("toast"),
};

const MAX_HISTORY = 20;
const STORAGE_KEY = "mirai-voice:last-voice";
const LLM_PROVIDER_KEY = "mirai-voice:llm-provider";
const LLM_MODEL_KEY = "mirai-voice:local-model";
const TTS_PROVIDER_KEY = "mirai-voice:tts-provider";

let maxLength = 1000;
let history = []; // { id, text, voice, url, filename, createdAt }
let chatHistory = []; // { role: "user" | "model", text: string }
let currentPersonaId = "taku";
let personasList = [];
let voicesList = [];
let avatarSourcesList = [];
let activeId = null;
let audioCtx = null;
let analyser = null;
let freqData = null;

/* ---------- ユーティリティ ---------- */

function formatTime(sec) {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function timestampForFile(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function setRangeFill(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 1;
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--fill", `${pct}%`);
}

let toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 6000);
}

function b64ToBlobUrl(b64, mimeType = "") {
  const resolvedMime = mimeType || (b64 && b64.startsWith("UklGR") ? "audio/wav" : "audio/mpeg");
  const byteChars = atob(b64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: resolvedMime });
  return URL.createObjectURL(blob);
}

/* ---------- 初期設定・ステータス ---------- */

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    els.modelBadge.textContent = `TTS: ${data.model}`;
    if (data.has_gemini_key) {
      els.geminiBadge.textContent = "Gemini: 準備完了";
      els.geminiBadge.className = "badge badge-ok";
    } else {
      els.geminiBadge.textContent = "Gemini: キー未設定";
      els.geminiBadge.className = "badge badge-warn";
    }
  } catch (e) {
    console.warn("Config load failed", e);
  }
}

async function loadVoices() {
  try {
    const res = await fetch("/api/voices");
    const data = await res.json();
    voicesList = data.voices || [];
    els.voice.innerHTML = "";
    if (!voicesList.length) {
      els.voice.innerHTML = '<option value="">声が未登録です</option>';
      showToast("声が登録されていません。先に python voice_clone.py clone ... で作成してください。");
      return;
    }
    for (const v of voicesList) {
      const opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = v.avatar ? `${v.name} (🖼️ ${v.avatar})` : v.name;
      els.voice.append(opt);
    }
    const last = localStorage.getItem(STORAGE_KEY);
    if (last && voicesList.some((v) => v.name === last)) els.voice.value = last;
    await syncAvatarWithVoice(els.voice.value, { silent: true });
  } catch (e) {
    els.voice.innerHTML = '<option value="">読み込み失敗</option>';
    showToast("声の一覧を取得できませんでした。サーバーが起動しているか確認してください。");
  }
}

async function syncAvatarWithVoice(voiceName, { silent = false } = {}) {
  if (!voiceName) return;
  const v = voicesList.find((x) => x.name === voiceName);
  if (!v || !v.avatar) return;
  if (els.avatarSourceSelect && els.avatarSourceSelect.value === v.avatar) {
    return;
  }
  try {
    const res = await fetch("/api/avatar/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: v.avatar }),
    });
    const data = await res.json();
    if (res.ok && data.current_source) {
      if (els.avatarSourceSelect) els.avatarSourceSelect.value = data.current_source;
      if (els.mainAvatarImg) {
        els.mainAvatarImg.src = `/avatars/${encodeURIComponent(data.current_source)}`;
      }
      setMainIdleVideo(data.idle_video_urls || data.idle_video_url || null);
      if (avatarBC && data.state) {
        avatarBC.postMessage({ type: "state_update", state: data.state });
      }
      if (!silent) {
        showToast(`声「${voiceName}」に合わせて画像「${data.current_source}」に切り替えました`);
      }
    }
  } catch (e) {
    console.warn("声に紐づく画像の切り替え失敗:", e);
  }
}

/* ---------- タブ切り替え ---------- */

function switchTab(targetBtn, targetPanel) {
  const tabs = [
    { btn: els.tabChat, panel: els.panelChat },
    { btn: els.tabTts, panel: els.panelTts },
    { btn: els.tabLine, panel: els.panelLine },
  ];
  for (const t of tabs) {
    if (!t.btn || !t.panel) continue;
    const isTarget = t.btn === targetBtn;
    t.btn.classList.toggle("is-active", isTarget);
    t.btn.setAttribute("aria-selected", String(isTarget));
    t.panel.classList.toggle("is-hidden", !isTarget);
  }
  if (targetBtn === els.tabLine) {
    loadLineStatus();
  }
}

els.tabChat.addEventListener("click", () => {
  switchTab(els.tabChat, els.panelChat);
  els.chatInput.focus();
});

els.tabTts.addEventListener("click", () => {
  switchTab(els.tabTts, els.panelTts);
  els.ttsText.focus();
});

if (els.tabLine) {
  els.tabLine.addEventListener("click", () => {
    switchTab(els.tabLine, els.panelLine);
  });
}

/* ---------- LINE 育成パネル管理 ---------- */

async function loadLineStatus() {
  try {
    const res = await fetch("/api/line/status?person_id=" + encodeURIComponent(currentPersonaId));
    if (!res.ok) return;
    const data = await res.json();

    if (els.lineBadge) {
      if (data.configured) {
        els.lineBadge.textContent = "LINE: 連携済";
        els.lineBadge.className = "badge badge-success";
      } else {
        els.lineBadge.textContent = "LINE: 未設定";
        els.lineBadge.className = "badge badge-warn";
      }
    }

    if (els.lineConfigStatus) {
      els.lineConfigStatus.textContent = data.configured ? "連携中（準備OK）" : "未設定 (.env確認)";
      els.lineConfigStatus.style.color = data.configured ? "#06c755" : "var(--warn)";
    }
    if (els.lineTotalCount) els.lineTotalCount.textContent = `${data.total_logs} 件`;
    if (els.lineUnlearnedCount) els.lineUnlearnedCount.textContent = `${data.unlearned_logs} 件`;
    if (els.lineUsersCount) els.lineUsersCount.textContent = `${data.users_count || 0} 人`;
    if (els.lineLogsBadge) els.lineLogsBadge.textContent = `${data.total_logs} 件`;

    if (els.lineActivePersonaBadge) {
      els.lineActivePersonaBadge.textContent = data.default_persona_name || "市川 拓";
    }

    // Webhook URL の表示（現在のホストから自動生成）
    if (els.webhookUrlCode) {
      const url = `${window.location.origin}/api/line/webhook`;
      els.webhookUrlCode.textContent = url;
    }

    renderLineLogs(data.recent_logs || []);
  } catch (e) {
    console.warn("LINEステータス取得失敗:", e);
  }
}

function renderLineLogs(logs) {
  if (!els.lineLogsList) return;
  els.lineLogsList.innerHTML = "";

  if (!logs || logs.length === 0) {
    els.lineLogsList.innerHTML = '<div class="empty-state">まだLINEからの会話ログがありません。LINEで話しかけるとここにリアルタイムで蓄積されます。</div>';
    return;
  }

  // 新しい順に表示
  const reversed = [...logs].reverse();
  for (const item of reversed) {
    const card = document.createElement("div");
    card.className = "line-log-card";

    // どのペルソナの発言か動的に判定
    const targetP = personasList.find((p) => p.id === (item.person_id || "taku"));
    const senderName = targetP ? (targetP.nickname || targetP.name) : "本人";

    const userRow = document.createElement("div");
    userRow.className = "log-row-user";
    userRow.innerHTML = `<span class="log-tag log-tag-user">${escapeHtml(senderName)}</span> <span>${escapeHtml(item.user_message)}</span>`;

    const aiRow = document.createElement("div");
    aiRow.className = "log-row-ai";
    aiRow.innerHTML = `<span class="log-tag log-tag-ai">AI</span> <span>${escapeHtml(item.ai_reply)}</span>`;

    const metaFoot = document.createElement("div");
    metaFoot.className = "log-meta-foot";

    const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "";
    const statusClass = item.learned ? "learned" : "unlearned";
    const statusText = item.learned ? "学習済" : "未学習";

    metaFoot.innerHTML = `<span>${timeStr} (${escapeHtml(targetP ? targetP.name : "市川 拓")})</span> <span class="status-pill ${statusClass}">${statusText}</span>`;

    card.append(userRow, aiRow, metaFoot);
    els.lineLogsList.append(card);
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

if (els.setLineActivePersonaBtn) {
  els.setLineActivePersonaBtn.addEventListener("click", async () => {
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(currentPersonaId)}/set_line_default`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "設定に失敗しました");
      showToast(data.message || "LINEの対話・学習相手を変更しました！");
      await loadLineStatus();
    } catch (e) {
      showToast(e.message);
    }
  });
}

if (els.lineRefreshBtn) {
  els.lineRefreshBtn.addEventListener("click", () => {
    loadLineStatus();
    showToast("LINE会話ログを更新しました");
  });
}

if (els.copyWebhookBtn && els.webhookUrlCode) {
  els.copyWebhookBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(els.webhookUrlCode.textContent).then(() => {
      showToast("Webhook URL をコピーしました！");
    }).catch(() => {
      showToast("コピーに失敗しました。直接選択してコピーしてください。");
    });
  });
}

if (els.lineProactiveBtn) {
  els.lineProactiveBtn.addEventListener("click", async () => {
    els.lineProactiveBtn.disabled = true;
    els.lineProactiveBtn.classList.add("is-loading");
    els.lineProactiveBtn.querySelector(".btn-label").textContent = "Geminiが話題を考案中...";

    const categoryId = els.lineTopicSelect ? els.lineTopicSelect.value : "";

    try {
      const res = await fetch("/api/line/proactive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category_id: categoryId, person_id: currentPersonaId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "自発質問の送信に失敗しました");

      showToast(data.message || "LINEに質問を送信しました！");
      await loadLineStatus();
    } catch (e) {
      showToast(e.message);
    } finally {
      els.lineProactiveBtn.disabled = false;
      els.lineProactiveBtn.classList.remove("is-loading");
      els.lineProactiveBtn.querySelector(".btn-label").textContent = "💡 質問する（話題を振る）";
    }
  });
}

if (els.lineLearnBtn) {
  els.lineLearnBtn.addEventListener("click", async () => {
    els.lineLearnBtn.disabled = true;
    els.lineLearnBtn.classList.add("is-loading");
    els.lineLearnBtn.querySelector(".btn-label").textContent = "AI人格を学習・更新中...";

    try {
      const res = await fetch("/api/line/learn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ person_id: currentPersonaId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "学習に失敗しました");

      showToast(data.message || "LINEの会話からAI人格を学習・更新しました！");
      await loadLineStatus();
    } catch (e) {
      showToast(e.message);
    } finally {
      els.lineLearnBtn.disabled = false;
      els.lineLearnBtn.classList.remove("is-loading");
      els.lineLearnBtn.querySelector(".btn-label").textContent = "✨ LINE会話からAI人格を学習・更新";
    }
  });
}

/* ---------- LINEチャット履歴の一括インポート・学習 ---------- */

if (els.lineImportFile) {
  els.lineImportFile.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (els.lineImportFilename) els.lineImportFilename.textContent = file.name;

    try {
      const buffer = await file.arrayBuffer();
      // まず UTF-8 でデコード
      let text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);

      // 文字化け（置換文字 \ufffd）が多い場合、Windows/LINEエクスポート特有の Shift-JIS (CP932) を試行
      const ufffdCount = (text.match(/\ufffd/g) || []).length;
      if (ufffdCount > 5) {
        try {
          const sjisText = new TextDecoder("shift-jis").decode(buffer);
          const sjisUfffd = (sjisText.match(/\ufffd/g) || []).length;
          if (sjisUfffd < ufffdCount) {
            text = sjisText;
          }
        } catch (_) {}
      }

      // 不可視制御文字・BOM・NULL文字等をサニタイズ
      text = text
        .replace(/\ufeff/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");

      if (els.lineImportText) {
        els.lineImportText.value = text;
      }
    } catch (err) {
      console.warn("ファイル読み込みフォールバック:", err);
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (els.lineImportText) els.lineImportText.value = evt.target.result;
      };
      reader.readAsText(file, "utf-8");
    }
  });
}

if (els.lineImportBtn) {
  els.lineImportBtn.addEventListener("click", async () => {
    const text = (els.lineImportText ? els.lineImportText.value : "").trim();
    if (!text) {
      showToast("チャット履歴のテキストを入力するかファイルを選択してください");
      return;
    }

    els.lineImportBtn.disabled = true;
    els.lineImportBtn.classList.add("is-loading");
    els.lineImportBtn.querySelector(".btn-label").textContent = "Geminiが解析・学習中...";
    if (els.lineImportStatus) els.lineImportStatus.textContent = "⏳ 会話ログの解析と人格学習を実行しています...";

    try {
      const res = await fetch("/api/line/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, auto_learn: true, person_id: currentPersonaId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "インポートに失敗しました");

      if (els.lineImportStatus) els.lineImportStatus.textContent = `✓ ${data.message}`;
      showToast("チャット履歴を取り込み、AI人格に学習させました！");
      if (els.lineImportText) els.lineImportText.value = "";
      if (els.lineImportFilename) els.lineImportFilename.textContent = "";
      if (els.lineImportFile) els.lineImportFile.value = "";
      await loadLineStatus();
    } catch (e) {
      if (els.lineImportStatus) els.lineImportStatus.textContent = `❌ エラー: ${e.message}`;
      showToast(e.message);
    } finally {
      els.lineImportBtn.disabled = false;
      els.lineImportBtn.classList.remove("is-loading");
      els.lineImportBtn.querySelector(".btn-label").textContent = "📥 チャットを読み込んで学習";
    }
  });
}


/* ---------- オーディオキュー管理（ストリーミング連続再生） ---------- */

class AudioQueuePlayer {
  constructor() {
    this.queue = [];
    this.isPlaying = false;
    this.currentAudio = null;
    this.onStateChange = null;
  }

  enqueue(item) {
    this.queue.push(item);
    if (!this.isPlaying) {
      this.playNext();
    }
  }

  clear() {
    this.queue = [];
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this.isPlaying = false;
  }

  playNext() {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      this.currentAudio = null;
      if (this.onStateChange) this.onStateChange(false, null);
      return;
    }

    this.isPlaying = true;
    const current = this.queue.shift();
    if (this.onStateChange) this.onStateChange(true, current);

    const audio = new Audio(current.url);
    this.currentAudio = audio;
    audio.onended = () => {
      this.playNext();
    };
    audio.onerror = (e) => {
      console.warn("セグメント再生エラー:", e);
      this.playNext();
    };
    audio.play().catch((err) => {
      console.warn("自動再生エラー:", err);
      this.playNext();
    });
  }

  playAll(items) {
    this.clear();
    for (const it of items) {
      this.queue.push(it);
    }
    this.playNext();
  }
}

const audioQueue = new AudioQueuePlayer();

audioQueue.onStateChange = (playing, current) => {
  if (playing && current) {
    els.nowPlaying.textContent = `市川 拓（たく）: ${current.text}`;
  } else {
    els.nowPlaying.textContent = "待機中";
  }
};

/* ---------- アバター映像（Ditto TalkingHead）連携 & 別画面制御 ---------- */

let avatarWinRef = null;
const avatarBC = ("BroadcastChannel" in window) ? new BroadcastChannel("mirai_avatar_channel") : null;

function isAvatarWinOpen() {
  return Boolean(avatarWinRef && !avatarWinRef.closed);
}

function openAvatarWindow() {
  const w = 960;
  const h = 720;
  const left = Math.max(0, (window.screen.width - w) / 2);
  const top = Math.max(0, (window.screen.height - h) / 2);
  avatarWinRef = window.open(
    "/avatar",
    "MiraiAvatarScreen",
    `width=${w},height=${h},left=${left},top=${top},resizable=yes`
  );
  if (avatarWinRef) {
    avatarWinRef.focus();
    showToast("🎬 映像出力画面を別ウィンドウで開きました！");
  } else {
    showToast("ポップアップがブロックされました。ブラウザの許可設定を確認するか /avatar を別タブで開いてください。");
  }
}

if (els.openAvatarWinBtn) els.openAvatarWinBtn.addEventListener("click", openAvatarWindow);
if (els.popoutAvatarBtn) els.popoutAvatarBtn.addEventListener("click", openAvatarWindow);

function setChatOnlyMode(enabled) {
  document.body.classList.toggle("chat-only-mode", enabled);
  if (els.toggleChatOnlyBtn) {
    els.toggleChatOnlyBtn.textContent = enabled ? "📐 通常レイアウトに戻す" : "💬 チャットのみ表示";
    els.toggleChatOnlyBtn.style.borderColor = enabled ? "var(--accent-1)" : "";
  }
}

if (els.toggleChatOnlyBtn) {
  els.toggleChatOnlyBtn.addEventListener("click", () => {
    const next = !document.body.classList.contains("chat-only-mode");
    setChatOnlyMode(next);
  });
}

if (window.location.pathname === "/chat" || new URLSearchParams(window.location.search).get("mode") === "chat") {
  setChatOnlyMode(true);
}

let currentMainIdleUrl = "";
let mainIdlePlaylist = [];
let mainIdleIdx = 0;

function pickNextMainIdleIndex() {
  if (mainIdlePlaylist.length <= 1) return 0;
  const candidates = [];
  for (let i = 0; i < mainIdlePlaylist.length; i++) {
    if (i !== mainIdleIdx) candidates.push(i);
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function playMainIdleIndex(idx) {
  if (!els.mainAvatarIdleVideo || !mainIdlePlaylist.length) return;
  mainIdleIdx = idx % mainIdlePlaylist.length;
  const targetUrl = mainIdlePlaylist[mainIdleIdx];
  currentMainIdleUrl = targetUrl;
  els.mainAvatarIdleVideo.loop = (mainIdlePlaylist.length === 1);
  els.mainAvatarIdleVideo.src = targetUrl;
  els.mainAvatarIdleVideo.onloadeddata = () => {
    els.mainAvatarIdleVideo.style.display = "block";
    els.mainAvatarIdleVideo.play().catch(() => {});
  };
  els.mainAvatarIdleVideo.play().catch(() => {});
}

if (els.mainAvatarIdleVideo) {
  els.mainAvatarIdleVideo.addEventListener("ended", () => {
    if (mainIdlePlaylist.length > 1) {
      playMainIdleIndex(pickNextMainIdleIndex());
    }
  });
}

function setMainIdleVideo(idleUrlsOrSingle) {
  if (!els.mainAvatarIdleVideo) return;
  const list = Array.isArray(idleUrlsOrSingle)
    ? idleUrlsOrSingle.filter(Boolean)
    : (idleUrlsOrSingle ? [idleUrlsOrSingle] : []);
  if (!list.length) {
    mainIdlePlaylist = [];
    currentMainIdleUrl = "";
    els.mainAvatarIdleVideo.style.display = "none";
    els.mainAvatarIdleVideo.removeAttribute("src");
    return;
  }
  const sameList = list.length === mainIdlePlaylist.length && list.every((u, i) => u === mainIdlePlaylist[i]);
  mainIdlePlaylist = list;
  els.mainAvatarIdleVideo.loop = (mainIdlePlaylist.length === 1);
  if (sameList && els.mainAvatarIdleVideo.style.display === "block") {
    if (els.mainAvatarIdleVideo.paused) els.mainAvatarIdleVideo.play().catch(() => {});
    return;
  }
  if (currentMainIdleUrl && mainIdlePlaylist.includes(currentMainIdleUrl) && els.mainAvatarIdleVideo.style.display === "block") {
    mainIdleIdx = mainIdlePlaylist.indexOf(currentMainIdleUrl);
    return;
  }
  playMainIdleIndex(0);
}

async function pollIdleVideoIfReady() {
  if (mainIdlePlaylist.length >= 3) return;
  try {
    const res = await fetch("/api/avatar/state");
    if (!res.ok) return;
    const st = await res.json();
    if (st.idle_video_urls && st.idle_video_urls.length) {
      setMainIdleVideo(st.idle_video_urls);
    } else if (st.idle_video_url) {
      setMainIdleVideo(st.idle_video_url);
    }
  } catch (_) {}
}
setInterval(pollIdleVideoIfReady, 2500);

function populateVoiceAvatarSelects(sources) {
  for (const sel of [els.cloneAvatarSelect, els.linkAvatarSelect]) {
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = '<option value="">（指定なし / 現在の画像）</option>';
    for (const s of sources) {
      const opt = document.createElement("option");
      opt.value = s.filename;
      opt.textContent = s.filename;
      sel.appendChild(opt);
    }
    if (prev && sources.some((s) => s.filename === prev)) {
      sel.value = prev;
    }
  }
}

async function loadAvatarSources() {
  if (!els.avatarSourceSelect) return;
  try {
    const res = await fetch("/api/avatar/sources");
    if (!res.ok) return;
    const data = await res.json();
    avatarSourcesList = data.sources || [];
    els.avatarSourceSelect.innerHTML = "";
    for (const s of avatarSourcesList) {
      const opt = document.createElement("option");
      opt.value = s.filename;
      opt.textContent = s.filename;
      els.avatarSourceSelect.appendChild(opt);
    }
    populateVoiceAvatarSelects(avatarSourcesList);
    if (data.current_source) {
      els.avatarSourceSelect.value = data.current_source;
      if (els.mainAvatarImg) {
        els.mainAvatarImg.src = `/avatars/${encodeURIComponent(data.current_source)}`;
      }
      setMainIdleVideo(data.idle_video_urls || data.idle_video_url || null);
    }
  } catch (e) {
    console.warn("アバター画像一覧の取得失敗:", e);
  }
}

if (els.avatarSourceSelect) {
  els.avatarSourceSelect.addEventListener("change", async () => {
    const filename = els.avatarSourceSelect.value;
    if (!filename) return;
    try {
      const res = await fetch("/api/avatar/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      const data = await res.json();
      if (res.ok && data.current_source) {
        if (els.mainAvatarImg) {
          els.mainAvatarImg.src = `/avatars/${encodeURIComponent(data.current_source)}`;
        }
        setMainIdleVideo(data.idle_video_urls || data.idle_video_url || null);
        if (avatarBC && data.state) {
          avatarBC.postMessage({ type: "state_update", state: data.state });
        }
        showToast(`アバターの顔を「${data.current_source}」に変更しました`);
      }
    } catch (e) {
      showToast("顔画像の変更に失敗しました");
    }
  });
}

if (els.avatarUploadInput) {
  els.avatarUploadInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/avatar/sources", { method: "POST", body: fd });
      const data = await res.json();
      if (res.ok) {
        await loadAvatarSources();
        if (avatarBC && data.state) {
          avatarBC.postMessage({ type: "state_update", state: data.state });
        }
        showToast(`顔画像「${data.current_source}」をアップロードしました！`);
      } else {
        showToast(data.error || "アップロード失敗");
      }
    } catch (err) {
      showToast("アップロードエラー: " + err.message);
    }
  });
}

if (avatarBC) {
  avatarBC.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === "source_changed" && msg.filename) {
      loadAvatarSources();
    } else if (msg.type === "avatar_chat_sync" && msg.userText && msg.replyText) {
      appendChatBubble("user", msg.userText);
      appendChatBubble("model", msg.replyText);
      chatHistory.push({ role: "user", text: msg.userText });
      chatHistory.push({ role: "model", text: msg.replyText });
    }
  };
}

const mainVideoQueue = [];
let isPlayingMainVideo = false;

function _startMainPreviewVideo(videoUrl) {
  if (!els.mainAvatarVideo) return;
  isPlayingMainVideo = true;
  els.mainAvatarVideo.style.opacity = "0";
  els.mainAvatarVideo.src = videoUrl + "?t=" + Date.now();
  // 別ウィンドウで映像画面が開いている場合、またはチャットのみモード時は、二重音声を防ぐためメイン画面側をミュート
  const muteLocal = isAvatarWinOpen() || document.body.classList.contains("chat-only-mode");
  els.mainAvatarVideo.muted = muteLocal;
  els.mainAvatarVideo.onloadeddata = () => {
    els.mainAvatarVideo.style.opacity = "1";
    els.mainAvatarVideo.style.pointerEvents = "auto";
  };
  els.mainAvatarVideo.play().then(() => {
    els.mainAvatarVideo.style.opacity = "1";
    els.mainAvatarVideo.style.pointerEvents = "auto";
  }).catch((err) => {
    console.warn("プレビュー動画再生失敗:", err);
    isPlayingMainVideo = false;
  });
}

function playMainPreviewVideo(videoUrl) {
  if (!els.mainAvatarVideo || !videoUrl) return;
  if (isPlayingMainVideo) {
    mainVideoQueue.push(videoUrl);
    return;
  }
  _startMainPreviewVideo(videoUrl);
}

function notifyVideoPlayed(videoUrl) {
  if (!videoUrl || !videoUrl.includes("/videos/talk_")) return;
  fetch("/api/avatar/video_played", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_url: videoUrl }),
  }).catch(() => {});
}

if (els.mainAvatarVideo) {
  els.mainAvatarVideo.addEventListener("ended", () => {
    const finishedUrl = els.mainAvatarVideo.currentSrc || els.mainAvatarVideo.src;
    notifyVideoPlayed(finishedUrl);
    if (mainVideoQueue.length > 0) {
      const nextUrl = mainVideoQueue.shift();
      _startMainPreviewVideo(nextUrl);
      return;
    }
    isPlayingMainVideo = false;
    els.mainAvatarVideo.style.opacity = "0";
    els.mainAvatarVideo.style.pointerEvents = "none";
    els.mainAvatarVideo.removeAttribute("src");
  });
}

async function generateAndPlayAvatarVideo(audioBase64List, replyText, metaEl = null, taskId = null) {
  if (!taskId && (!audioBase64List || audioBase64List.length === 0)) return null;

  const currentPersona = personasList.find((p) => p.id === currentPersonaId);
  const personaName = currentPersona ? currentPersona.name : "市川 拓";
  const sourceFilename = els.avatarSourceSelect ? els.avatarSourceSelect.value : "";

  if (els.avatarGenBadge) els.avatarGenBadge.style.display = "block";
  els.nowPlaying.textContent = "🎬 チャット返答からアバター映像を生成中...";

  let genBadgeEl = null;
  if (metaEl) {
    genBadgeEl = document.createElement("span");
    genBadgeEl.className = "bubble-timing";
    genBadgeEl.style.color = "var(--accent-2)";
    genBadgeEl.textContent = "🎬 映像生成中...";
    metaEl.prepend(genBadgeEl);
  }

  if (avatarBC) {
    avatarBC.postMessage({
      type: "state_update",
      state: {
        status: "generating",
        status_text: "チャット返答からリップシンク映像を生成中...",
        reply_text: replyText,
        persona_name: personaName,
      },
    });
  }

  try {
    const reqBody = taskId
      ? { task_id: taskId, text: replyText, persona_name: personaName, source_filename: sourceFilename }
      : { audio_base64_list: audioBase64List, text: replyText, persona_name: personaName, source_filename: sourceFilename };
    const res = await fetch("/api/avatar/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "映像生成に失敗しました");

    if (avatarBC && data.state) {
      avatarBC.postMessage({ type: "state_update", state: data.state });
    }

    playMainPreviewVideo(data.video_url);
    const vt = data.timing;
    if (vt) {
      console.log(
        `[SPEED LOG] 🎬 映像生成完了: 合計 ${vt.total_video_sec}s (音声変換: ${vt.audio_prep_sec}s / Ditto GPU: ${vt.ditto_gen_sec}s / 音声尺: ${vt.audio_duration_sec}s / ${vt.frames}f @ ${vt.effective_fps}fps)`
      );
      els.nowPlaying.textContent = `🎬 映像再生中 (生成 ${vt.total_video_sec}s): ${replyText}`;
      if (genBadgeEl) {
        genBadgeEl.title = `音声変換: ${vt.audio_prep_sec}s / Ditto GPU: ${vt.ditto_gen_sec}s / 音声尺: ${vt.audio_duration_sec}s (${vt.frames}frames, ${vt.effective_fps}fps)`;
        genBadgeEl.textContent = `🎬 映像 ${vt.total_video_sec}s`;
      }
    } else {
      els.nowPlaying.textContent = `🎬 映像再生中: ${replyText}`;
      if (genBadgeEl) {
        genBadgeEl.textContent = "🎬 映像再生完了";
      }
    }
    return data.video_url;
  } catch (err) {
    console.error("映像生成エラー:", err);
    showToast("映像生成エラー: " + err.message);
    if (genBadgeEl) genBadgeEl.textContent = "⚠️ 映像エラー";
    return null;
  } finally {
    if (els.avatarGenBadge) els.avatarGenBadge.style.display = "none";
  }
}

/* ---------- 音声認識 (Web Speech API ＋ Gemini STT フォールバック) ---------- */

let speechRec = null;
let isRecordingVoice = false;
let mediaRecorder = null;
let recordedChunks = [];
let mediaStream = null;
let voiceBaseText = "";
let voiceFinalText = "";
let voiceHasResult = false;
let preferServerStt = false;

function setMicUiState(state) {
  if (!els.micBtn) return;
  els.micBtn.classList.remove("is-recording", "is-transcribing");
  if (state === "recording") {
    els.micBtn.classList.add("is-recording");
    els.micBtn.textContent = "⏹️";
    els.micBtn.title = "クリックして音声入力を停止";
  } else if (state === "transcribing") {
    els.micBtn.classList.add("is-transcribing");
    els.micBtn.textContent = "⏳";
    els.micBtn.title = "音声を文字起こし中...";
  } else {
    els.micBtn.textContent = "🎤";
    els.micBtn.title = "マイクで音声入力（クリックで開始/停止）";
  }
}

function stopMediaRecorderStt() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  isRecordingVoice = false;
}

async function startMediaRecorderStt() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast("この環境ではマイク入力が利用できません（localhost または https:// で開いてください）");
    setMicUiState("idle");
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);

    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recordedChunks.push(ev.data);
    };

    mediaRecorder.onstop = async () => {
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
      }
      if (!recordedChunks.length) {
        setMicUiState("idle");
        return;
      }
      setMicUiState("transcribing");
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      const fd = new FormData();
      fd.append("audio", blob, "voice.webm");
      try {
        const res = await fetch("/api/stt", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "音声認識に失敗しました");
        const recognized = (data.text || "").trim();
        if (recognized) {
          els.chatInput.value = (voiceBaseText ? voiceBaseText + " " : "") + recognized;
          if (els.autoSendVoiceToggle && els.autoSendVoiceToggle.checked && !els.sendChatBtn.disabled) {
            sendChat();
          } else {
            els.chatInput.focus();
          }
        } else {
          showToast("音声を聞き取れませんでした。もう一度お試しください。");
        }
      } catch (err) {
        showToast(err.message);
      } finally {
        setMicUiState("idle");
      }
    };

    voiceBaseText = els.chatInput.value.trim();
    isRecordingVoice = true;
    setMicUiState("recording");
    mediaRecorder.start();
    showToast("🎙️ 録音中... 話し終わったらもう一度ボタンを押してください");
  } catch (err) {
    isRecordingVoice = false;
    setMicUiState("idle");
    if (err.name === "NotAllowedError") {
      showToast("マイクの使用が許可されていません。ブラウザのマイク権限を確認してください。");
    } else {
      showToast("マイクを起動できませんでした: " + err.message);
    }
  }
}

function startWebSpeechStt() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec || preferServerStt) {
    startMediaRecorderStt();
    return;
  }

  speechRec = new SpeechRec();
  speechRec.lang = "ja-JP";
  speechRec.interimResults = true;
  speechRec.continuous = false;

  voiceBaseText = els.chatInput.value.trim();
  voiceFinalText = "";
  voiceHasResult = false;
  let fallbackTriggered = false;

  speechRec.onstart = () => {
    isRecordingVoice = true;
    setMicUiState("recording");
  };

  speechRec.onresult = (ev) => {
    let interim = "";
    let finalSeg = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const tr = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) {
        finalSeg += tr;
      } else {
        interim += tr;
      }
    }
    if (finalSeg) {
      voiceFinalText += finalSeg;
      voiceHasResult = true;
    }
    const combined = (voiceFinalText + interim).trim();
    if (combined) {
      els.chatInput.value = (voiceBaseText ? voiceBaseText + " " : "") + combined;
    }
  };

  speechRec.onerror = (ev) => {
    isRecordingVoice = false;
    if (ev.error === "network" || ev.error === "service-not-allowed") {
      // ブラウザ標準の音声認識が使えない場合はサーバー側 Gemini STT へ自動フォールバック
      preferServerStt = true;
      fallbackTriggered = true;
      startMediaRecorderStt();
      return;
    }
    setMicUiState("idle");
    if (ev.error === "not-allowed") {
      showToast("マイクの使用が許可されていません。ブラウザの権限を許可してください。");
    } else if (ev.error !== "aborted" && ev.error !== "no-speech") {
      showToast(`音声認識エラー: ${ev.error}`);
    }
  };

  speechRec.onend = () => {
    if (fallbackTriggered) return;
    isRecordingVoice = false;
    setMicUiState("idle");
    const textToSend = els.chatInput.value.trim();
    if (voiceHasResult && textToSend && els.autoSendVoiceToggle && els.autoSendVoiceToggle.checked && !els.sendChatBtn.disabled) {
      sendChat();
    } else if (textToSend) {
      els.chatInput.focus();
    }
  };

  try {
    speechRec.start();
  } catch (e) {
    isRecordingVoice = false;
    setMicUiState("idle");
    startMediaRecorderStt();
  }
}

function toggleVoiceInput() {
  if (isRecordingVoice) {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopMediaRecorderStt();
    } else if (speechRec) {
      speechRec.stop();
    }
    return;
  }
  startWebSpeechStt();
}

if (els.micBtn) {
  els.micBtn.addEventListener("click", toggleVoiceInput);
}

/* ---------- ローカルLLM (Ollama) 設定管理 ---------- */

async function loadLlmStatus() {
  if (els.ttsProviderSelect) {
    const savedTts = localStorage.getItem(TTS_PROVIDER_KEY);
    if (savedTts && ["fish", "gemini-lite", "gemini-flash", "local"].includes(savedTts)) {
      els.ttsProviderSelect.value = savedTts;
    }
  }
  if (!els.llmProviderSelect || !els.localModelSelect) return;
  const savedProvider = localStorage.getItem(LLM_PROVIDER_KEY);
  if (savedProvider === "ollama" || savedProvider === "gemini") {
    els.llmProviderSelect.value = savedProvider;
  }
  const updateModelSelectVisibility = () => {
    const isLocal = els.llmProviderSelect.value === "ollama";
    els.localModelSelect.style.display = isLocal ? "inline-block" : "none";
  };
  updateModelSelectVisibility();

  try {
    const res = await fetch("/api/llm/status");
    if (!res.ok) return;
    const data = await res.json();
    els.localModelSelect.innerHTML = "";
    if (data.ollama_running && data.models && data.models.length > 0) {
      for (const m of data.models) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        els.localModelSelect.appendChild(opt);
      }
      const savedModel = localStorage.getItem(LLM_MODEL_KEY);
      if (savedModel && data.models.includes(savedModel)) {
        els.localModelSelect.value = savedModel;
      } else if (data.default_local_model && data.models.includes(data.default_local_model)) {
        els.localModelSelect.value = data.default_local_model;
      }
    } else {
      const opt = document.createElement("option");
      opt.value = data.default_local_model || "qwen2.5:7b";
      opt.textContent = data.ollama_running ? "モデル未DL (qwen2.5:7b等)" : "Ollama未起動";
      els.localModelSelect.appendChild(opt);
    }
  } catch (e) {
    console.warn("LLM状態取得失敗:", e);
  }
}

if (els.llmProviderSelect) {
  els.llmProviderSelect.addEventListener("change", () => {
    const val = els.llmProviderSelect.value;
    localStorage.setItem(LLM_PROVIDER_KEY, val);
    if (els.localModelSelect) {
      els.localModelSelect.style.display = val === "ollama" ? "inline-block" : "none";
    }
    if (val === "ollama") {
      loadLlmStatus();
    }
  });
}

if (els.localModelSelect) {
  els.localModelSelect.addEventListener("change", () => {
    localStorage.setItem(LLM_MODEL_KEY, els.localModelSelect.value);
  });
}

if (els.ttsProviderSelect) {
  els.ttsProviderSelect.addEventListener("change", () => {
    localStorage.setItem(TTS_PROVIDER_KEY, els.ttsProviderSelect.value);
  });
}

/* ---------- AI対話 (Chat - ストリーミング版) ---------- */

function setChatLoading(loading) {
  els.sendChatBtn.disabled = loading;
  els.sendChatBtn.classList.toggle("is-loading", loading);
  const withTts = els.enableTtsToggle ? els.enableTtsToggle.checked : false;
  els.sendChatBtn.querySelector(".btn-label").textContent = loading
    ? (withTts ? "思考＆発話中..." : "思考中...")
    : "話す";
  if (loading) els.nowPlaying.textContent = withTts ? "思考中＆音声生成中..." : "考え中...";
}

async function sendChat() {
  const message = els.chatInput.value.trim();
  const voice = els.voice.value;

  if (!message) return;
  if (!voice) {
    showToast("声を選択してください。");
    return;
  }

  const useAvatarVideo = els.enableAvatarVideoToggle ? els.enableAvatarVideoToggle.checked : true;
  const enableTts = (els.enableTtsToggle ? els.enableTtsToggle.checked : false) || useAvatarVideo;

  if (enableTts && !useAvatarVideo) ensureAudioGraph();
  setChatLoading(true);

  // 1. ユーザーの吹き出しを追加
  appendChatBubble("user", message);
  els.chatInput.value = "";

  const speed = Number(els.speed.value);

  // 2. AIの吹き出しをプレースホルダーとして配置（リアルタイムタイピング用）
  const aiBubble = createStreamingAiBubble();
  const textEl = aiBubble.querySelector(".bubble-text");
  const metaEl = aiBubble.querySelector(".bubble-meta");
  const cursorEl = aiBubble.querySelector(".typing-cursor");

  let fullReplyText = "";
  const audioSegments = [];
  const audioBase64Segments = [];
  let firstAudioPlayed = false;
  let avatarPipelineChain = Promise.resolve();
  let pipelinedVideoCount = 0;

  const llmProvider = els.llmProviderSelect ? els.llmProviderSelect.value : "gemini";
  const llmModel = els.localModelSelect ? els.localModelSelect.value : "";
  const ttsProvider = els.ttsProviderSelect ? els.ttsProviderSelect.value : "fish";

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        voice,
        person_id: currentPersonaId,
        speed: speed === 1 ? null : speed,
        history: chatHistory,
        enable_tts: enableTts,
        avatar_mode: useAvatarVideo,
        llm_provider: llmProvider,
        llm_model: llmModel,
        tts_provider: ttsProvider,
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop(); // 未完了の行をバッファに残す

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;

        let payload;
        try {
          payload = JSON.parse(jsonStr);
        } catch (pe) {
          console.warn("SSEパースエラー:", pe, jsonStr);
          continue;
        }

        if (payload.type === "text_chunk") {
          fullReplyText += payload.text;
          textEl.textContent = fullReplyText;
          if (cursorEl) textEl.appendChild(cursorEl);
          els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
        } else if (payload.type === "audio_segment") {
          const blobUrl = b64ToBlobUrl(payload.audio_base64);
          const segItem = {
            index: payload.index,
            text: payload.text,
            url: blobUrl,
            latencySec: payload.latency_sec,
          };
          audioSegments.push(segItem);
          audioBase64Segments.push(payload.audio_base64);

          if (!firstAudioPlayed) {
            firstAudioPlayed = true;
            console.log(`[DEBUG] ⚡ 初声レイテンシー: ${payload.latency_sec}秒`);
          }

          // アバター映像モードがOFFの時は音声を即時再生、ONの時は1文目から即座に先行映像生成＆キュー再生
          if (!useAvatarVideo) {
            audioQueue.enqueue(segItem);
          } else if (payload.avatar_task_id) {
            pipelinedVideoCount += 1;
            const segNum = pipelinedVideoCount;
            const taskId = payload.avatar_task_id;
            const segText = payload.text;
            const segB64 = payload.audio_base64;
            avatarPipelineChain = avatarPipelineChain.then(() =>
              generateAndPlayAvatarVideo([segB64], segText, segNum === 1 ? metaEl : null, taskId)
            );
          }
        } else if (payload.type === "done") {
          if (cursorEl) cursorEl.remove();

          // タイミング情報
          const timing = payload.timing;
          if (timing) {
            console.log(
              `[DEBUG] ⏱️ 完了: 合計 ${timing.total_sec}秒 (Gemini初速: ${timing.gemini_first_sec}秒, 最初の声: ${timing.first_audio_sec || "-"}秒, TTS計: ${timing.tts_total_sec}秒)`
            );
            const timingBadge = document.createElement("span");
            timingBadge.className = "bubble-timing";
            if (timing.enable_tts && timing.first_audio_sec) {
              timingBadge.title = `最初の声: ${timing.first_audio_sec}s / Gemini: ${timing.gemini_first_sec}s / 全完了: ${timing.total_sec}s`;
              timingBadge.textContent = `⚡ 初声 ${timing.first_audio_sec}s / ⏱️ ${timing.total_sec}s`;
            } else {
              timingBadge.title = `Gemini: ${timing.gemini_total_sec}s / 全完了: ${timing.total_sec}s`;
              timingBadge.textContent = `⚡ ${timing.gemini_total_sec}s`;
            }
            metaEl.prepend(timingBadge);
          }

          // 「もう一度聴く」または「声で聴く」ボタンの設定
          const playBtn = document.createElement("button");
          playBtn.className = "bubble-play-btn";
          playBtn.type = "button";

          if (audioSegments.length > 0) {
            let generatedVideoUrl = null;
            playBtn.innerHTML = useAvatarVideo ? "▶ 映像をもう一度再生" : "▶ もう一度聴く";
            playBtn.addEventListener("click", () => {
              if (generatedVideoUrl) {
                playMainPreviewVideo(generatedVideoUrl);
                if (avatarBC) {
                  avatarBC.postMessage({
                    type: "state_update",
                    state: {
                      status: "ready",
                      video_id: Date.now(),
                      video_url: generatedVideoUrl,
                      reply_text: fullReplyText,
                    },
                  });
                }
              } else {
                ensureAudioGraph();
                audioQueue.playAll(audioSegments);
              }
            });
            metaEl.append(playBtn);

            // 履歴に追加
            addHistory({
              id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
              text: fullReplyText,
              voice: payload.voice,
              url: audioSegments[0].url,
              filename: `tts_${timestampForFile(new Date())}.mp3`,
              createdAt: new Date(),
            });

            // 1文目先行パイプラインで未起動の場合のみ、done後にまとめて生成
            if (useAvatarVideo && pipelinedVideoCount === 0 && (payload.avatar_task_id || audioBase64Segments.length > 0)) {
              generateAndPlayAvatarVideo(audioBase64Segments, fullReplyText, metaEl, payload.avatar_task_id || null).then((vUrl) => {
                if (vUrl) generatedVideoUrl = vUrl;
              });
            }
          } else {
            // TTSがOFFだった場合：オンデマンドで生成するボタン
            playBtn.innerHTML = "🎬 映像で話す / 声で聴く";
            playBtn.addEventListener("click", async () => {
              playBtn.disabled = true;
              playBtn.innerHTML = "⏳ 生成中...";
              try {
                const spd = Number(els.speed.value);
                const resTts = await fetch("/api/tts", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    text: fullReplyText,
                    voice: els.voice.value,
                    speed: spd === 1 ? null : spd,
                  }),
                });
                if (!resTts.ok) throw new Error("音声の生成に失敗しました");
                const blob = await resTts.blob();
                const item = {
                  id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
                  text: fullReplyText,
                  voice: els.voice.value,
                  url: URL.createObjectURL(blob),
                  filename: `tts_${timestampForFile(new Date())}.mp3`,
                  createdAt: new Date(),
                };
                addHistory(item);
                const wantVideo = els.enableAvatarVideoToggle ? els.enableAvatarVideoToggle.checked : true;
                if (wantVideo) {
                  const arrBuf = await blob.arrayBuffer();
                  const bytes = new Uint8Array(arrBuf);
                  let binary = "";
                  for (let i = 0; i < bytes.byteLength; i++) {
                    binary += String.fromCharCode(bytes[i]);
                  }
                  const b64 = btoa(binary);
                  const vUrl = await generateAndPlayAvatarVideo([b64], fullReplyText, metaEl);
                  playBtn.disabled = false;
                  playBtn.innerHTML = "▶ 映像をもう一度再生";
                  playBtn.onclick = () => {
                    if (vUrl) {
                      playMainPreviewVideo(vUrl);
                      if (avatarBC) {
                        avatarBC.postMessage({
                          type: "state_update",
                          state: { status: "ready", video_id: Date.now(), video_url: vUrl, reply_text: fullReplyText },
                        });
                      }
                    } else {
                      playItem(item);
                    }
                  };
                } else {
                  ensureAudioGraph();
                  playItem(item);
                  playBtn.disabled = false;
                  playBtn.innerHTML = "▶ もう一度聴く";
                  playBtn.onclick = () => playItem(item);
                }
              } catch (e) {
                showToast(e.message);
                playBtn.disabled = false;
                playBtn.innerHTML = "🎬 映像で話す / 声で聴く";
              }
            });
            metaEl.append(playBtn);
          }

          // 会話履歴更新
          chatHistory.push({ role: "user", text: message });
          chatHistory.push({ role: "model", text: fullReplyText });
        } else if (payload.type === "error") {
          throw new Error(payload.message || "ストリーミングエラー");
        }
      }
    }
  } catch (e) {
    if (cursorEl) cursorEl.remove();
    showToast(e.message);
    textEl.textContent = `（エラー: ${e.message}）`;
    els.nowPlaying.textContent = "対話エラー";
  } finally {
    setChatLoading(false);
    els.chatInput.focus();
  }
}

function createStreamingAiBubble() {
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-ai";

  const p = document.createElement("p");
  p.className = "bubble-text";

  const cursor = document.createElement("span");
  cursor.className = "typing-cursor";
  p.appendChild(cursor);

  const meta = document.createElement("div");
  meta.className = "bubble-meta";

  bubble.append(p, meta);
  els.chatMessages.append(bubble);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  return bubble;
}

function appendChatBubble(role, text, audioItem = null, timing = null) {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble chat-bubble-${role === "user" ? "user" : "ai"}`;
  
  const p = document.createElement("p");
  p.textContent = text;
  bubble.append(p);

  if (role === "model") {
    const meta = document.createElement("div");
    meta.className = "bubble-meta";

    if (timing) {
      const timingBadge = document.createElement("span");
      timingBadge.className = "bubble-timing";
      timingBadge.title = `Gemini: ${timing.gemini_sec}s / TTS: ${timing.tts_sec}s`;
      timingBadge.textContent = `⏱️ ${timing.total_sec}s`;
      meta.append(timingBadge);
    }

    const playBtn = document.createElement("button");
    playBtn.className = "bubble-play-btn";
    playBtn.type = "button";

    if (audioItem && audioItem.url) {
      playBtn.innerHTML = "▶ もう一度聴く";
      playBtn.addEventListener("click", () => {
        ensureAudioGraph();
        playItem(audioItem);
      });
    } else {
      playBtn.innerHTML = "🔊 声で聴く";
      playBtn.addEventListener("click", async () => {
        ensureAudioGraph();
        playBtn.disabled = true;
        playBtn.innerHTML = "⏳ 生成中...";
        try {
          const speed = Number(els.speed.value);
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text,
              voice: els.voice.value,
              speed: speed === 1 ? null : speed,
            }),
          });
          if (!res.ok) throw new Error("音声の生成に失敗しました");
          const blob = await res.blob();
          const item = {
            id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
            text,
            voice: els.voice.value,
            url: URL.createObjectURL(blob),
            filename: `tts_${timestampForFile(new Date())}.mp3`,
            createdAt: new Date(),
          };
          addHistory(item);
          playItem(item);
          playBtn.disabled = false;
          playBtn.innerHTML = "▶ もう一度聴く";
          playBtn.onclick = () => playItem(item);
        } catch (e) {
          showToast(e.message);
          playBtn.disabled = false;
          playBtn.innerHTML = "🔊 声で聴く";
        }
      });
    }

    meta.append(playBtn);
    bubble.append(meta);
  }

  els.chatMessages.append(bubble);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

/* ---------- テキスト読み上げ (TTS) ---------- */

function setTtsLoading(loading) {
  els.speakBtn.disabled = loading;
  els.speakBtn.classList.toggle("is-loading", loading);
  els.speakBtn.querySelector(".btn-label").textContent = loading ? "生成中..." : "読み上げる";
  if (loading) els.nowPlaying.textContent = "音声を生成しています...";
}

async function speakTts() {
  const text = els.ttsText.value.trim();
  const voice = els.voice.value;
  if (!text) {
    showToast("読み上げる文章を入力してください。");
    els.ttsText.focus();
    return;
  }
  if (!voice) {
    showToast("声を選択してください。");
    return;
  }

  ensureAudioGraph();
  setTtsLoading(true);

  const speed = Number(els.speed.value);
  const ttsProvider = els.ttsProviderSelect ? els.ttsProviderSelect.value : "fish";
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, speed: speed === 1 ? null : speed, tts_provider: ttsProvider }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const createdAt = new Date();
    const item = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      text,
      voice,
      url: URL.createObjectURL(blob),
      filename: `tts_${timestampForFile(createdAt)}.mp3`,
      createdAt,
    };
    addHistory(item);
    const useAvatarVideo = els.enableAvatarVideoToggle ? els.enableAvatarVideoToggle.checked : true;
    if (useAvatarVideo) {
      const arrBuf = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrBuf);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const b64 = btoa(binary);
      await generateAndPlayAvatarVideo([b64], text);
    } else {
      playItem(item);
    }
  } catch (e) {
    els.nowPlaying.textContent = "生成に失敗しました";
    showToast(e.message);
  } finally {
    setTtsLoading(false);
  }
}

/* ---------- 再生コントロール ---------- */

function ensureAudioGraph() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    audioCtx.createMediaElementSource(els.audio).connect(analyser);
    analyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
}

function playItem(item) {
  activeId = item.id;
  els.audio.src = item.url;
  els.audio.play().catch(() => showToast("自動再生がブロックされました。再生ボタンを押してください。"));
  els.nowPlaying.textContent = `${item.voice}：${item.text}`;
  els.playBtn.disabled = false;
  els.seek.disabled = false;
  els.download.href = item.url;
  els.download.download = item.filename;
  els.download.classList.remove("is-disabled");
  els.download.removeAttribute("aria-disabled");
  renderHistory();
}

function togglePlay() {
  ensureAudioGraph();
  if (els.audio.paused) els.audio.play();
  else els.audio.pause();
}

els.audio.addEventListener("play", () => els.playBtn.classList.add("is-playing"));
els.audio.addEventListener("pause", () => els.playBtn.classList.remove("is-playing"));
els.audio.addEventListener("ended", () => els.playBtn.classList.remove("is-playing"));
els.audio.addEventListener("loadedmetadata", () => {
  els.seek.max = els.audio.duration || 0;
  els.timeTotal.textContent = formatTime(els.audio.duration);
});
els.audio.addEventListener("timeupdate", () => {
  if (!seeking) els.seek.value = els.audio.currentTime;
  els.timeCurrent.textContent = formatTime(els.audio.currentTime);
  setRangeFill(els.seek);
});

let seeking = false;
els.seek.addEventListener("input", () => {
  seeking = true;
  els.timeCurrent.textContent = formatTime(Number(els.seek.value));
  setRangeFill(els.seek);
});
els.seek.addEventListener("change", () => {
  els.audio.currentTime = Number(els.seek.value);
  seeking = false;
});

/* ---------- 履歴 ---------- */

function addHistory(item) {
  history.unshift(item);
  while (history.length > MAX_HISTORY) URL.revokeObjectURL(history.pop().url);
  renderHistory();
}

function renderHistory() {
  els.historyList.innerHTML = "";
  if (!history.length) {
    els.historyList.innerHTML = '<li class="history-empty">まだ発話はありません</li>';
    return;
  }
  for (const item of history) {
    const li = document.createElement("li");
    li.className = "history-item" + (item.id === activeId ? " is-active" : "");
    li.title = item.text;

    const dot = document.createElement("span");
    dot.className = "history-dot";

    const body = document.createElement("div");
    body.className = "history-body";
    const text = document.createElement("p");
    text.className = "history-text";
    text.textContent = item.text;
    const meta = document.createElement("p");
    meta.className = "history-meta";
    meta.textContent = `${item.voice}・${item.createdAt.toLocaleTimeString("ja-JP")}`;
    body.append(text, meta);

    const dl = document.createElement("a");
    dl.className = "btn-ghost";
    dl.href = item.url;
    dl.download = item.filename;
    dl.title = "mp3 をダウンロード";
    dl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg>';
    dl.addEventListener("click", (e) => e.stopPropagation());

    li.append(dot, body, dl);
    li.addEventListener("click", () => {
      ensureAudioGraph();
      playItem(item);
    });
    els.historyList.append(li);
  }
}

function clearHistory() {
  els.audio.pause();
  els.audio.removeAttribute("src");
  els.audio.load();
  for (const item of history) URL.revokeObjectURL(item.url);
  history = [];
  activeId = null;
  els.playBtn.disabled = true;
  els.seek.disabled = true;
  els.seek.value = 0;
  setRangeFill(els.seek);
  els.timeCurrent.textContent = "0:00";
  els.timeTotal.textContent = "0:00";
  els.download.classList.add("is-disabled");
  els.download.removeAttribute("href");
  els.nowPlaying.textContent = "メッセージを送信するか文章を読み上げてください";
  renderHistory();
}

/* ---------- ビジュアライザー ---------- */

const ctx2d = els.canvas.getContext("2d");

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = els.canvas.getBoundingClientRect();
  els.canvas.width = Math.round(width * dpr);
  els.canvas.height = Math.round(height * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw(t) {
  const { width, height } = els.canvas.getBoundingClientRect();
  ctx2d.clearRect(0, 0, width, height);

  const bars = 48;
  const gap = 4;
  const barW = (width - gap * (bars - 1)) / bars;
  const mid = height * 0.45;
  const playing = analyser && !els.audio.paused;

  if (playing) analyser.getByteFrequencyData(freqData);

  const grad = ctx2d.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0, "hsl(262, 90%, 68%)");
  grad.addColorStop(0.5, "hsl(220, 90%, 65%)");
  grad.addColorStop(1, "hsl(190, 95%, 58%)");
  ctx2d.fillStyle = grad;

  for (let i = 0; i < bars; i++) {
    let level;
    if (playing) {
      const idx = Math.floor((i / bars) * freqData.length * 0.7);
      level = freqData[idx] / 255;
    } else {
      level = 0.05 + 0.04 * Math.sin(t / 600 + i * 0.35);
    }
    const h = Math.max(2, level * (height * 0.7));
    const x = i * (barW + gap);
    ctx2d.globalAlpha = 0.95;
    roundRect(x, mid - h / 2, barW, h, barW / 2);
  }
  ctx2d.globalAlpha = 1;
  requestAnimationFrame(draw);
}

function roundRect(x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx2d.beginPath();
  ctx2d.moveTo(x + r, y);
  ctx2d.arcTo(x + w, y, x + w, y + h, r);
  ctx2d.arcTo(x + w, y + h, x, y + h, r);
  ctx2d.arcTo(x, y + h, x, y, r);
  ctx2d.arcTo(x, y, x + w, y, r);
  ctx2d.fill();
}

/* ---------- マルチペルソナ（人物AI）管理 ---------- */

async function loadPersonas() {
  try {
    const res = await fetch("/api/personas");
    if (!res.ok) return;
    const data = await res.json();
    personasList = data.personas || [];

    if (els.personaSelect) {
      els.personaSelect.innerHTML = "";
      for (const p of personasList) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = `${p.name} (${p.nickname || p.name})`;
        els.personaSelect.appendChild(opt);
      }
      els.personaSelect.value = currentPersonaId;
      if (!els.personaSelect.value && personasList.length > 0) {
        currentPersonaId = personasList[0].id;
        els.personaSelect.value = currentPersonaId;
      }
    }

    updateCurrentPersonaUI();
    localStorage.setItem("mirai-voice:current-persona", currentPersonaId);
  } catch (e) {
    console.warn("ペルソナ一覧の取得失敗:", e);
  }
}

function updateCurrentPersonaUI() {
  const current = personasList.find((p) => p.id === currentPersonaId);
  const name = current ? `${current.name} (${current.nickname || current.name})` : "市川 拓 (たく)";
  if (els.lineCurrentPersonaName) {
    els.lineCurrentPersonaName.textContent = name;
  }
  // そのペルソナに声が設定されていれば声を自動選択し、紐づく画像も同期
  if (current && current.voice_name && els.voice) {
    const voiceOpts = Array.from(els.voice.options);
    if (voiceOpts.some((o) => o.value === current.voice_name)) {
      els.voice.value = current.voice_name;
      syncAvatarWithVoice(current.voice_name, { silent: true });
    }
  }
}

if (els.personaSelect) {
  els.personaSelect.addEventListener("change", async (e) => {
    currentPersonaId = e.target.value;
    localStorage.setItem("mirai-voice:current-persona", currentPersonaId);
    updateCurrentPersonaUI();

    // LINEの会話・学習対象も連動切り替え
    try {
      await fetch(`/api/personas/${encodeURIComponent(currentPersonaId)}/set_line_default`, {
        method: "POST",
      });
    } catch (_) {}

    loadLineStatus();
    showToast(`操作対象・LINE学習対象を「${els.personaSelect.options[els.personaSelect.selectedIndex].text}」に切り替えました`);
  });
}

function populateNpVoiceSelect() {
  if (!els.npVoiceSelect || !els.voice) return;
  els.npVoiceSelect.innerHTML = '<option value="">（後で設定）</option>';
  for (const opt of els.voice.options) {
    if (!opt.value) continue;
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.textContent;
    els.npVoiceSelect.appendChild(o);
  }
}

if (els.addPersonaBtn) {
  els.addPersonaBtn.addEventListener("click", () => {
    if (!els.newPersonaDialog) return;
    if (els.npStatus) els.npStatus.textContent = "";
    if (els.formNewPersona) els.formNewPersona.reset();
    populateNpVoiceSelect();
    els.newPersonaDialog.showModal();
  });
}

if (els.closeNewPersonaBtn) {
  els.closeNewPersonaBtn.addEventListener("click", () => {
    if (els.newPersonaDialog) els.newPersonaDialog.close();
  });
}

if (els.formNewPersona) {
  els.formNewPersona.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!els.submitNewPersonaBtn) return;
    els.submitNewPersonaBtn.disabled = true;
    if (els.npStatus) els.npStatus.textContent = "AI人格を作成中...";

    const payload = {
      id: els.npId.value.trim(),
      name: els.npName.value.trim(),
      nickname: els.npNickname.value.trim(),
      first_person: els.npFirstPerson.value.trim(),
      attribute: els.npAttribute.value.trim(),
      personality: els.npPersonality.value.trim(),
      favorites: els.npFavorites.value.trim(),
      voice_name: els.npVoiceSelect ? els.npVoiceSelect.value : "",
    };

    try {
      const res = await fetch("/api/personas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "作成に失敗しました");

      currentPersonaId = data.persona.id;
      showToast(`「${data.persona.name}」の分身AIを作成しました！`);
      await loadPersonas();
      await loadLineStatus();
      if (els.newPersonaDialog) els.newPersonaDialog.close();
    } catch (err) {
      if (els.npStatus) els.npStatus.textContent = `❌ ${err.message}`;
      showToast(err.message);
    } finally {
      els.submitNewPersonaBtn.disabled = false;
    }
  });
}

/* ---------- 人格設定モーダル ---------- */

async function openPersonaDialog() {
  els.personaStatus.textContent = "";
  try {
    const res = await fetch("/api/personas/" + encodeURIComponent(currentPersonaId));
    const data = await res.json();
    els.personaTextarea.value = data.content || "";
  } catch (e) {
    els.personaTextarea.value = "読み込みに失敗しました";
  }
  els.dialog.showModal();
}

async function savePersona() {
  const content = els.personaTextarea.value.trim();
  if (!content) return;
  els.savePersonaBtn.disabled = true;
  try {
    const res = await fetch("/api/personas/" + encodeURIComponent(currentPersonaId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (res.ok) {
      els.personaStatus.textContent = "✓ 保存しました";
      setTimeout(() => els.dialog.close(), 1000);
    } else {
      showToast("保存に失敗しました");
    }
  } catch (e) {
    showToast("保存エラー: " + e.message);
  } finally {
    els.savePersonaBtn.disabled = false;
  }
}

if (els.personaBtn) els.personaBtn.addEventListener("click", openPersonaDialog);
if (els.closeDialogBtn) els.closeDialogBtn.addEventListener("click", () => els.dialog.close());
if (els.savePersonaBtn) els.savePersonaBtn.addEventListener("click", savePersona);

/* ---------- クローン音声の管理・追加モーダル ---------- */

async function openVoiceDialog() {
  if (!els.voiceDialog) return;
  if (els.cloneStatus) els.cloneStatus.textContent = "";
  if (els.linkStatus) els.linkStatus.textContent = "";
  await loadVoiceManageList();
  els.voiceDialog.showModal();
}

async function loadVoiceManageList() {
  if (!els.voiceManageList) return;
  els.voiceManageList.innerHTML = '<div class="empty-state">読み込み中...</div>';
  try {
    const res = await fetch("/api/voices");
    const data = await res.json();
    renderVoiceManageList(data.voices || []);
  } catch (e) {
    els.voiceManageList.innerHTML = '<div class="empty-state">声一覧の取得に失敗しました</div>';
  }
}

function renderVoiceManageList(voices) {
  if (!els.voiceManageList) return;
  els.voiceManageList.innerHTML = "";
  if (!voices || voices.length === 0) {
    els.voiceManageList.innerHTML = '<div class="empty-state">登録されている声がありません。下から追加してください。</div>';
    return;
  }

  for (const v of voices) {
    const card = document.createElement("div");
    card.className = "voice-item-card";

    const info = document.createElement("div");
    info.className = "voice-item-info";
    info.innerHTML = `
      <span class="voice-item-name">${escapeHtml(v.name)}</span>
      <span class="voice-item-id">ID: ${escapeHtml(v.id || "-")}</span>
    `;

    const avatarBindWrap = document.createElement("div");
    avatarBindWrap.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap;";
    const avatarSelect = document.createElement("select");
    avatarSelect.style.cssText = "font-size:0.75rem;padding:2px 6px;max-width:160px;";
    avatarSelect.title = "この声に紐付ける顔画像";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "🖼️ 画像未設定";
    avatarSelect.appendChild(noneOpt);
    for (const s of avatarSourcesList) {
      const opt = document.createElement("option");
      opt.value = s.filename;
      opt.textContent = `🖼️ ${s.filename}`;
      avatarSelect.appendChild(opt);
    }
    avatarSelect.value = v.avatar || "";
    avatarSelect.addEventListener("change", async () => {
      const newAvatar = avatarSelect.value;
      try {
        const res = await fetch(`/api/voices/${encodeURIComponent(v.name)}/avatar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ avatar: newAvatar }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "紐付けに失敗しました");
        showToast(newAvatar ? `声「${v.name}」に画像「${newAvatar}」を設定し、待機映像を準備しました` : `声「${v.name}」の画像紐付けを解除しました`);
        await loadVoices();
        if (els.voice.value === v.name && newAvatar) {
          await syncAvatarWithVoice(v.name, { silent: true });
        }
      } catch (err) {
        showToast(err.message);
      }
    });
    avatarBindWrap.appendChild(avatarSelect);
    info.appendChild(avatarBindWrap);

    const actions = document.createElement("div");
    actions.className = "voice-item-actions";

    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.className = "btn-voice-test";
    testBtn.textContent = "🔊 試聴";
    testBtn.addEventListener("click", () => testVoice(v.name, testBtn));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn-voice-delete";
    deleteBtn.textContent = "🗑️ 削除";
    deleteBtn.addEventListener("click", () => deleteVoice(v.name));

    actions.append(testBtn, deleteBtn);
    card.append(info, actions);
    els.voiceManageList.append(card);
  }
}

let testAudio = null;
async function testVoice(voiceName, btn) {
  if (testAudio) {
    testAudio.pause();
    testAudio = null;
  }
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "生成中...";
  try {
    const res = await fetch("/api/voices/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: voiceName }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "試聴音声の生成に失敗しました");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    testAudio = new Audio(url);
    btn.textContent = "再生中...";
    testAudio.onended = () => {
      btn.textContent = originalText;
      btn.disabled = false;
    };
    testAudio.onerror = () => {
      btn.textContent = originalText;
      btn.disabled = false;
    };
    await testAudio.play();
  } catch (e) {
    showToast(e.message);
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function deleteVoice(voiceName) {
  if (!confirm(`本当に声「${voiceName}」を削除しますか？`)) return;
  try {
    const res = await fetch(`/api/voices/${encodeURIComponent(voiceName)}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "削除に失敗しました");
    }
    showToast(`声「${voiceName}」を削除しました`);
    await loadVoices();
    await loadVoiceManageList();
  } catch (e) {
    showToast(e.message);
  }
}

if (els.vtabUpload && els.vtabId) {
  els.vtabUpload.addEventListener("click", () => {
    els.vtabUpload.classList.add("is-active");
    els.vtabId.classList.remove("is-active");
    if (els.formCloneAudio) els.formCloneAudio.classList.remove("is-hidden");
    if (els.formLinkId) els.formLinkId.classList.add("is-hidden");
  });
  els.vtabId.addEventListener("click", () => {
    els.vtabId.classList.add("is-active");
    els.vtabUpload.classList.remove("is-active");
    if (els.formLinkId) els.formLinkId.classList.remove("is-hidden");
    if (els.formCloneAudio) els.formCloneAudio.classList.add("is-hidden");
  });
}

if (els.formCloneAudio) {
  els.formCloneAudio.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = els.cloneVoiceName.value.trim();
    const file = els.cloneAudioFile.files[0];
    const refText = els.cloneRefText ? els.cloneRefText.value.trim() : "";
    const avatarSelectVal = els.cloneAvatarSelect ? els.cloneAvatarSelect.value : "";
    const avatarFile = els.cloneAvatarFile && els.cloneAvatarFile.files ? els.cloneAvatarFile.files[0] : null;

    if (!name || !file) {
      showToast("声の名前と音声ファイルは必須です");
      return;
    }

    const formData = new FormData();
    formData.append("name", name);
    formData.append("audio", file);
    if (refText) formData.append("ref_text", refText);
    if (avatarFile) formData.append("avatar_file", avatarFile);
    else if (avatarSelectVal) formData.append("avatar", avatarSelectVal);

    els.submitCloneBtn.disabled = true;
    els.submitCloneBtn.classList.add("is-loading");
    if (els.cloneStatus) els.cloneStatus.textContent = "⏳ Fish Audio API でクローン生成中...";

    try {
      const res = await fetch("/api/voices", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "クローン作成に失敗しました");

      const hasAvatar = Boolean(data.avatar);
      if (els.cloneStatus) {
        els.cloneStatus.textContent = hasAvatar && !data.idle_video_url
          ? "✓ 登録完了！待機映像をバックグラウンドで生成中..."
          : "✓ クローン作成が完了しました！";
      }
      showToast(hasAvatar ? `声「${name}」と画像「${data.avatar}」を登録しました！` : `新しい声「${name}」を登録しました！`);
      els.cloneVoiceName.value = "";
      els.cloneAudioFile.value = "";
      if (els.cloneRefText) els.cloneRefText.value = "";
      if (els.cloneAvatarFile) els.cloneAvatarFile.value = "";
      await loadAvatarSources();
      await loadVoices();
      await loadVoiceManageList();
      els.voice.value = name;
      localStorage.setItem(STORAGE_KEY, name);
      await syncAvatarWithVoice(name, { silent: true });
    } catch (err) {
      if (els.cloneStatus) els.cloneStatus.textContent = `❌ エラー: ${err.message}`;
      showToast(err.message);
    } finally {
      els.submitCloneBtn.disabled = false;
      els.submitCloneBtn.classList.remove("is-loading");
    }
  });
}

if (els.formLinkId) {
  els.formLinkId.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = els.linkVoiceName.value.trim();
    const voiceId = els.linkVoiceId.value.trim();
    const avatarSelectVal = els.linkAvatarSelect ? els.linkAvatarSelect.value : "";
    const avatarFile = els.linkAvatarFile && els.linkAvatarFile.files ? els.linkAvatarFile.files[0] : null;

    if (!name || !voiceId) {
      showToast("声の名前とReference IDを入力してください");
      return;
    }

    els.submitLinkBtn.disabled = true;
    if (els.linkStatus) els.linkStatus.textContent = "⏳ 登録中...";

    try {
      let res;
      if (avatarFile) {
        const fd = new FormData();
        fd.append("name", name);
        fd.append("id", voiceId);
        fd.append("avatar_file", avatarFile);
        res = await fetch("/api/voices", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/voices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, id: voiceId, avatar: avatarSelectVal }),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "登録に失敗しました");

      const hasAvatar = Boolean(data.avatar);
      if (els.linkStatus) {
        els.linkStatus.textContent = hasAvatar && !data.idle_video_url
          ? "✓ 登録完了！待機映像をバックグラウンドで生成中..."
          : "✓ 登録しました！";
      }
      showToast(hasAvatar ? `声「${name}」と画像「${data.avatar}」を登録しました！` : `声「${name}」を登録しました！`);
      els.linkVoiceName.value = "";
      els.linkVoiceId.value = "";
      if (els.linkAvatarFile) els.linkAvatarFile.value = "";
      await loadAvatarSources();
      await loadVoices();
      await loadVoiceManageList();
      els.voice.value = name;
      localStorage.setItem(STORAGE_KEY, name);
      await syncAvatarWithVoice(name, { silent: true });
    } catch (err) {
      if (els.linkStatus) els.linkStatus.textContent = `❌ エラー: ${err.message}`;
      showToast(err.message);
    } finally {
      els.submitLinkBtn.disabled = false;
    }
  });
}

if (els.manageVoicesBtn) els.manageVoicesBtn.addEventListener("click", openVoiceDialog);
if (els.closeVoiceDialogBtn && els.voiceDialog) els.closeVoiceDialogBtn.addEventListener("click", () => els.voiceDialog.close());

/* ---------- 一気通貫 分身AI作成ウィザード（写真撮影・録音・アンケート） ---------- */

(function initSetupWizard() {
  const openBtn = $("open-wizard-btn");
  const dialog = $("wizard-dialog");
  const closeBtn = $("close-wizard-btn");
  if (!openBtn || !dialog) return;

  const stepPills = Array.from(dialog.querySelectorAll(".wstep-pill"));
  const panels = [1, 2, 3].map((n) => $(`wizard-step-${n}`));

  const wizVideo = $("wiz-video");
  const wizPhotoPreview = $("wiz-photo-preview");
  const wizCanvas = $("wiz-canvas");
  const camSelect = $("wiz-camera-select");
  const startCamBtn = $("wiz-start-cam-btn");
  const captureBtn = $("wiz-capture-btn");
  const retakeBtn = $("wiz-retake-btn");
  const photoFileInput = $("wiz-photo-file");
  const step1Status = $("wiz-step1-status");
  const next1Btn = $("wiz-next-1-btn");

  const recBtn = $("wiz-rec-btn");
  const recTimer = $("wiz-rec-timer");
  const audioFileInput = $("wiz-audio-file");
  const audioPreview = $("wiz-audio-preview");
  const back2Btn = $("wiz-back-2-btn");
  const step2Status = $("wiz-step2-status");
  const next2Btn = $("wiz-next-2-btn");

  const back3Btn = $("wiz-back-3-btn");
  const submitStatus = $("wiz-submit-status");
  const submitBtn = $("wiz-submit-btn");

  let camStream = null;
  let capturedPhotoBlob = null;
  let capturedPhotoName = "photo.png";

  let wizRecStream = null;
  let wizMediaRec = null;
  let wizAudioChunks = [];
  let recordedAudioBlob = null;
  let recordedAudioName = "voice.webm";
  let recTimerId = null;
  let recStartMs = 0;

  function stopCamera() {
    if (camStream) {
      camStream.getTracks().forEach((t) => t.stop());
      camStream = null;
    }
    if (wizVideo) wizVideo.srcObject = null;
    if (captureBtn) captureBtn.disabled = true;
  }

  function stopWizAudioRec() {
    if (wizMediaRec && wizMediaRec.state === "recording") {
      wizMediaRec.stop();
    }
    if (recTimerId) {
      clearInterval(recTimerId);
      recTimerId = null;
    }
  }

  function goToStep(stepNum) {
    stepPills.forEach((p) => {
      p.classList.toggle("is-active", Number(p.dataset.wstep) === stepNum);
    });
    panels.forEach((panel, idx) => {
      if (panel) panel.classList.toggle("is-hidden", idx + 1 !== stepNum);
    });
    if (stepNum === 1 && !capturedPhotoBlob && !camStream) {
      startCamera();
    }
    if (stepNum !== 1) {
      stopCamera();
    }
  }

  async function refreshCameraList(selectedId = "") {
    if (!camSelect || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter((d) => d.kind === "videoinput");
      const prev = selectedId || camSelect.value;
      camSelect.innerHTML = '<option value="">📷 カメラを自動選択</option>';
      videoInputs.forEach((d, idx) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `カメラ ${idx + 1}`;
        camSelect.appendChild(opt);
      });
      if (prev && videoInputs.some((d) => d.deviceId === prev)) {
        camSelect.value = prev;
      }
    } catch (_) {}
  }

  async function startCamera(deviceId = "") {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (step1Status) step1Status.textContent = "⚠️ カメラが使えないため画像ファイルを選択してください（localhost/httpsが必要）";
      return;
    }
    const targetId = deviceId || (camSelect ? camSelect.value : "");
    try {
      stopCamera();
      if (targetId) {
        camStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: targetId } } });
      } else {
        try {
          camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } });
        } catch (_) {
          camStream = await navigator.mediaDevices.getUserMedia({ video: true });
        }
      }
      wizVideo.srcObject = camStream;
      wizVideo.style.display = "block";
      wizPhotoPreview.style.display = "none";
      captureBtn.disabled = false;
      retakeBtn.style.display = "none";
      const activeTrack = camStream.getVideoTracks()[0];
      const activeId = activeTrack && activeTrack.getSettings ? activeTrack.getSettings().deviceId : "";
      await refreshCameraList(targetId || activeId || "");
      if (step1Status) step1Status.textContent = "📷 カメラ準備完了";
    } catch (err) {
      await refreshCameraList();
      const reason = err && err.name ? `${err.name}: ${err.message}` : String(err);
      console.warn("Camera error:", reason);
      if (step1Status) {
        if (err && err.name === "NotFoundError") {
          step1Status.textContent = "⚠️ カメラが認識されていません（画像ファイル選択も使えます）";
        } else if (err && err.name === "NotAllowedError") {
          step1Status.textContent = "⚠️ ブラウザのカメラ許可が拒否されています（アドレスバー左の🔒から許可してください）";
        } else {
          step1Status.textContent = `⚠️ カメラ起動失敗 (${err.name || "Error"})`;
        }
      }
    }
  }

  openBtn.addEventListener("click", () => {
    capturedPhotoBlob = null;
    recordedAudioBlob = null;
    if (wizPhotoPreview) wizPhotoPreview.style.display = "none";
    if (wizVideo) wizVideo.style.display = "block";
    if (audioPreview) {
      audioPreview.style.display = "none";
      audioPreview.removeAttribute("src");
    }
    if (recTimer) recTimer.textContent = "0:00";
    if (step1Status) step1Status.textContent = "";
    if (step2Status) step2Status.textContent = "";
    if (submitStatus) submitStatus.textContent = "";
    goToStep(1);
    dialog.showModal();
  });

  function closeWizard() {
    stopCamera();
    stopWizAudioRec();
    if (wizRecStream) {
      wizRecStream.getTracks().forEach((t) => t.stop());
      wizRecStream = null;
    }
    dialog.close();
  }

  if (closeBtn) closeBtn.addEventListener("click", closeWizard);
  dialog.addEventListener("close", () => {
    stopCamera();
    stopWizAudioRec();
  });

  stepPills.forEach((p) => {
    p.addEventListener("click", () => goToStep(Number(p.dataset.wstep)));
  });

  if (startCamBtn) startCamBtn.addEventListener("click", () => startCamera());
  if (camSelect) {
    camSelect.addEventListener("change", () => {
      capturedPhotoBlob = null;
      startCamera(camSelect.value);
    });
  }

  if (captureBtn) {
    captureBtn.addEventListener("click", () => {
      if (!wizVideo || !wizVideo.videoWidth) return;
      wizCanvas.width = wizVideo.videoWidth;
      wizCanvas.height = wizVideo.videoHeight;
      const ctx = wizCanvas.getContext("2d");
      // プレビューと同じく左右反転を元に戻して自然向きに保存
      ctx.save();
      ctx.translate(wizCanvas.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(wizVideo, 0, 0, wizCanvas.width, wizCanvas.height);
      ctx.restore();
      wizCanvas.toBlob((blob) => {
        if (!blob) return;
        capturedPhotoBlob = blob;
        capturedPhotoName = `capture_${Date.now()}.png`;
        wizPhotoPreview.src = URL.createObjectURL(blob);
        wizPhotoPreview.style.display = "block";
        wizVideo.style.display = "none";
        retakeBtn.style.display = "inline-flex";
        captureBtn.disabled = true;
        stopCamera();
        if (step1Status) step1Status.textContent = "✓ 写真を撮影しました！";
      }, "image/png");
    });
  }

  if (retakeBtn) {
    retakeBtn.addEventListener("click", () => {
      capturedPhotoBlob = null;
      startCamera();
    });
  }

  if (photoFileInput) {
    photoFileInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (!f) return;
      capturedPhotoBlob = f;
      capturedPhotoName = f.name || "photo.png";
      wizPhotoPreview.src = URL.createObjectURL(f);
      wizPhotoPreview.style.display = "block";
      wizVideo.style.display = "none";
      retakeBtn.style.display = "inline-flex";
      stopCamera();
      if (step1Status) step1Status.textContent = `✓ 「${f.name}」を選択しました`;
    });
  }

  if (next1Btn) {
    next1Btn.addEventListener("click", () => {
      if (!capturedPhotoBlob) {
        showToast("まず顔写真を撮影（または選択）してください");
        return;
      }
      goToStep(2);
    });
  }

  if (recBtn) {
    recBtn.addEventListener("click", async () => {
      if (wizMediaRec && wizMediaRec.state === "recording") {
        stopWizAudioRec();
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast("マイクが利用できません。音声ファイルを選択してください。");
        return;
      }
      try {
        wizRecStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        wizAudioChunks = [];
        const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
        wizMediaRec = mimeType ? new MediaRecorder(wizRecStream, { mimeType }) : new MediaRecorder(wizRecStream);
        wizMediaRec.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) wizAudioChunks.push(ev.data);
        };
        wizMediaRec.onstop = () => {
          if (wizRecStream) {
            wizRecStream.getTracks().forEach((t) => t.stop());
            wizRecStream = null;
          }
          if (recTimerId) {
            clearInterval(recTimerId);
            recTimerId = null;
          }
          recBtn.textContent = "🎙️ 録り直す";
          if (wizAudioChunks.length) {
            recordedAudioBlob = new Blob(wizAudioChunks, { type: wizMediaRec.mimeType || "audio/webm" });
            recordedAudioName = `rec_${Date.now()}.webm`;
            audioPreview.src = URL.createObjectURL(recordedAudioBlob);
            audioPreview.style.display = "block";
            if (step2Status) step2Status.textContent = "✓ 音声を録音しました！再生して確認できます";
          }
        };
        recStartMs = Date.now();
        recTimer.textContent = "0:00";
        recTimerId = setInterval(() => {
          const sec = Math.floor((Date.now() - recStartMs) / 1000);
          recTimer.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
        }, 250);
        wizMediaRec.start();
        recBtn.textContent = "⏹️ 録音ストップ";
        if (step2Status) step2Status.textContent = "🔴 録音中... 10〜20秒ほど話してください";
      } catch (err) {
        showToast("マイクを起動できませんでした: " + err.message);
      }
    });
  }

  if (audioFileInput) {
    audioFileInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (!f) return;
      recordedAudioBlob = f;
      recordedAudioName = f.name || "voice.wav";
      audioPreview.src = URL.createObjectURL(f);
      audioPreview.style.display = "block";
      if (step2Status) step2Status.textContent = `✓ 「${f.name}」を選択しました`;
    });
  }

  if (back2Btn) back2Btn.addEventListener("click", () => goToStep(1));
  if (next2Btn) {
    next2Btn.addEventListener("click", () => {
      if (wizMediaRec && wizMediaRec.state === "recording") {
        showToast("録音を停止してから次へ進んでください");
        return;
      }
      if (!recordedAudioBlob) {
        showToast("まず声を録音（または音声ファイルを選択）してください");
        return;
      }
      goToStep(3);
    });
  }

  if (back3Btn) back3Btn.addEventListener("click", () => goToStep(2));

  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      const nameVal = ($("wiz-name") ? $("wiz-name").value : "").trim();
      if (!nameVal) {
        showToast("お名前を入力してください");
        if ($("wiz-name")) $("wiz-name").focus();
        return;
      }
      if (!capturedPhotoBlob) {
        showToast("Step 1 の顔写真が未撮影です");
        goToStep(1);
        return;
      }
      if (!recordedAudioBlob) {
        showToast("Step 2 の音声が未録音です");
        goToStep(2);
        return;
      }

      const fd = new FormData();
      fd.append("photo", capturedPhotoBlob, capturedPhotoName);
      fd.append("audio", recordedAudioBlob, recordedAudioName);
      fd.append("name", nameVal);
      fd.append("nickname", ($("wiz-nickname") ? $("wiz-nickname").value : "").trim());
      fd.append("first_person", $("wiz-first-person") ? $("wiz-first-person").value : "私");
      fd.append("tone", $("wiz-tone") ? $("wiz-tone").value : "");
      fd.append("personality", ($("wiz-personality") ? $("wiz-personality").value : "").trim());
      fd.append("favorites", ($("wiz-favorites") ? $("wiz-favorites").value : "").trim());
      fd.append("catchphrase", ($("wiz-catchphrase") ? $("wiz-catchphrase").value : "").trim());
      fd.append("holiday", ($("wiz-holiday") ? $("wiz-holiday").value : "").trim());

      submitBtn.disabled = true;
      submitBtn.classList.add("is-loading");
      if (submitStatus) submitStatus.textContent = "⏳ 音声クローン作成＆人格・待機映像を生成中...";

      try {
        const res = await fetch("/api/wizard/create", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "作成に失敗しました");

        currentPersonaId = data.persona.id;
        localStorage.setItem("mirai-voice:current-persona", currentPersonaId);
        localStorage.setItem(STORAGE_KEY, data.voice_name);

        await loadAvatarSources();
        await loadVoices();
        await loadPersonas();

        if (els.voice) els.voice.value = data.voice_name;
        if (els.avatarSourceSelect) els.avatarSourceSelect.value = data.avatar;
        if (els.mainAvatarImg) els.mainAvatarImg.src = `/avatars/${encodeURIComponent(data.avatar)}`;
        setMainIdleVideo(data.state ? (data.state.idle_video_urls || data.state.idle_video_url) : null);
        if (avatarBC && data.state) {
          avatarBC.postMessage({ type: "state_update", state: data.state });
        }

        closeWizard();
        showToast(`🎉 「${data.persona.name}」の分身AIが完成しました！待機映像も自動で準備されます`);
      } catch (err) {
        if (submitStatus) submitStatus.textContent = `❌ ${err.message}`;
        showToast(err.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.classList.remove("is-loading");
      }
    });
  }
})();


/* ---------- イベントリスナー ---------- */

function updateSpeed() {
  els.speedValue.textContent = `${Number(els.speed.value).toFixed(1)}x`;
  setRangeFill(els.speed);
}

function updateCharCount() {
  const len = els.ttsText.value.length;
  els.charCount.textContent = `${len} / ${maxLength}`;
  els.charCount.classList.toggle("is-near", len > maxLength * 0.9);
}

els.chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!els.sendChatBtn.disabled) sendChat();
  }
});
els.sendChatBtn.addEventListener("click", sendChat);

els.ttsText.addEventListener("input", updateCharCount);
els.ttsText.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    if (!els.speakBtn.disabled) speakTts();
  }
});
els.speakBtn.addEventListener("click", speakTts);

els.speed.addEventListener("input", updateSpeed);
els.voice.addEventListener("change", () => {
  localStorage.setItem(STORAGE_KEY, els.voice.value);
  syncAvatarWithVoice(els.voice.value);
});
els.playBtn.addEventListener("click", togglePlay);
els.clearHistory.addEventListener("click", clearHistory);
window.addEventListener("resize", resizeCanvas);

/* ---------- 初期化 ---------- */

updateSpeed();
updateCharCount();
setRangeFill(els.seek);
resizeCanvas();
requestAnimationFrame(draw);
loadConfig();
loadLlmStatus();
loadAvatarSources().then(() => loadVoices());
loadPersonas();
loadLineStatus();
els.chatInput.focus();

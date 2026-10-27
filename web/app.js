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
  enableTtsToggle: $("enable-tts-toggle"),

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

  // 人格モーダル
  dialog: $("persona-dialog"),
  closeDialogBtn: $("close-dialog-btn"),
  personaTextarea: $("persona-textarea"),
  savePersonaBtn: $("save-persona-btn"),
  personaStatus: $("persona-status"),

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
  submitCloneBtn: $("submit-clone-btn"),
  cloneStatus: $("clone-status"),
  linkVoiceName: $("link-voice-name"),
  linkVoiceId: $("link-voice-id"),
  submitLinkBtn: $("submit-link-btn"),
  linkStatus: $("link-status"),

  toast: $("toast"),
};

const MAX_HISTORY = 20;
const STORAGE_KEY = "mirai-voice:last-voice";

let maxLength = 1000;
let history = []; // { id, text, voice, url, filename, createdAt }
let chatHistory = []; // { role: "user" | "model", text: string }
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

function b64ToBlobUrl(b64, mimeType = "audio/mpeg") {
  const byteChars = atob(b64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });
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
    els.voice.innerHTML = "";
    if (!data.voices.length) {
      els.voice.innerHTML = '<option value="">声が未登録です</option>';
      showToast("声が登録されていません。先に python voice_clone.py clone ... で作成してください。");
      return;
    }
    for (const v of data.voices) {
      const opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = v.name;
      els.voice.append(opt);
    }
    const last = localStorage.getItem(STORAGE_KEY);
    if (last && data.voices.some((v) => v.name === last)) els.voice.value = last;
  } catch (e) {
    els.voice.innerHTML = '<option value="">読み込み失敗</option>';
    showToast("声の一覧を取得できませんでした。サーバーが起動しているか確認してください。");
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
    const res = await fetch("/api/line/status");
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

    const userRow = document.createElement("div");
    userRow.className = "log-row-user";
    userRow.innerHTML = `<span class="log-tag log-tag-user">拓さん</span> <span>${escapeHtml(item.user_message)}</span>`;

    const aiRow = document.createElement("div");
    aiRow.className = "log-row-ai";
    aiRow.innerHTML = `<span class="log-tag log-tag-ai">AI</span> <span>${escapeHtml(item.ai_reply)}</span>`;

    const metaFoot = document.createElement("div");
    metaFoot.className = "log-meta-foot";

    const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "";
    const statusClass = item.learned ? "learned" : "unlearned";
    const statusText = item.learned ? "学習済" : "未学習";

    metaFoot.innerHTML = `<span>${timeStr}</span> <span class="status-pill ${statusClass}">${statusText}</span>`;

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
        body: JSON.stringify({ category_id: categoryId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "自発質問の送信に失敗しました");

      showToast(data.message || "拓さんのLINEに質問を送信しました！");
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
      const res = await fetch("/api/line/learn", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "学習に失敗しました");

      showToast(data.message || "LINEの会話からAI人格を学習・更新しました！");
      await loadLineStatus();
      await loadPersona();
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
  els.lineImportFile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (els.lineImportFilename) els.lineImportFilename.textContent = file.name;
    const reader = new FileReader();
    reader.onload = (evt) => {
      els.lineImportText.value = evt.target.result;
    };
    reader.readAsText(file, "utf-8");
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
        body: JSON.stringify({ text, auto_learn: true }),
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

  const enableTts = els.enableTtsToggle ? els.enableTtsToggle.checked : false;

  if (enableTts) ensureAudioGraph();
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
  let firstAudioPlayed = false;

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        voice,
        speed: speed === 1 ? null : speed,
        history: chatHistory,
        enable_tts: enableTts,
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
          // 音声セグメント受信 ➔ 即キュー投入＆再生
          const blobUrl = b64ToBlobUrl(payload.audio_base64);
          const segItem = {
            index: payload.index,
            text: payload.text,
            url: blobUrl,
            latencySec: payload.latency_sec,
          };
          audioSegments.push(segItem);

          if (!firstAudioPlayed) {
            firstAudioPlayed = true;
            console.log(`[DEBUG] ⚡ 初声レイテンシー: ${payload.latency_sec}秒`);
          }

          audioQueue.enqueue(segItem);
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
            playBtn.innerHTML = "▶ もう一度聴く";
            playBtn.addEventListener("click", () => {
              ensureAudioGraph();
              audioQueue.playAll(audioSegments);
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
          } else {
            // TTSがOFFだった場合：オンデマンドで生成するボタン
            playBtn.innerHTML = "🔊 声で聴く";
            playBtn.addEventListener("click", async () => {
              ensureAudioGraph();
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
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, speed: speed === 1 ? null : speed }),
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
    playItem(item);
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

/* ---------- 人格設定モーダル ---------- */

async function openPersonaDialog() {
  els.personaStatus.textContent = "";
  try {
    const res = await fetch("/api/persona");
    const data = await res.json();
    els.personaTextarea.value = data.prompt;
  } catch (e) {
    els.personaTextarea.value = "読み込みに失敗しました";
  }
  els.dialog.showModal();
}

async function savePersona() {
  const prompt = els.personaTextarea.value.trim();
  if (!prompt) return;
  els.savePersonaBtn.disabled = true;
  try {
    const res = await fetch("/api/persona", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
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

els.personaBtn.addEventListener("click", openPersonaDialog);
els.closeDialogBtn.addEventListener("click", () => els.dialog.close());
els.savePersonaBtn.addEventListener("click", savePersona);

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

    if (!name || !file) {
      showToast("声の名前と音声ファイルは必須です");
      return;
    }

    const formData = new FormData();
    formData.append("name", name);
    formData.append("audio", file);
    if (refText) formData.append("ref_text", refText);

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

      if (els.cloneStatus) els.cloneStatus.textContent = "✓ クローン作成が完了しました！";
      showToast(`新しい声「${name}」を登録しました！`);
      els.cloneVoiceName.value = "";
      els.cloneAudioFile.value = "";
      if (els.cloneRefText) els.cloneRefText.value = "";
      await loadVoices();
      await loadVoiceManageList();
      els.voice.value = name;
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

    if (!name || !voiceId) {
      showToast("声の名前とReference IDを入力してください");
      return;
    }

    els.submitLinkBtn.disabled = true;
    if (els.linkStatus) els.linkStatus.textContent = "⏳ 登録中...";

    try {
      const res = await fetch("/api/voices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, id: voiceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "登録に失敗しました");

      if (els.linkStatus) els.linkStatus.textContent = "✓ 登録しました！";
      showToast(`声「${name}」を登録しました！`);
      els.linkVoiceName.value = "";
      els.linkVoiceId.value = "";
      await loadVoices();
      await loadVoiceManageList();
      els.voice.value = name;
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
els.voice.addEventListener("change", () => localStorage.setItem(STORAGE_KEY, els.voice.value));
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
loadVoices();
loadLineStatus();
els.chatInput.focus();

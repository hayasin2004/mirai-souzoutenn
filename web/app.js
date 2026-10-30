"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  // ナビ & バッジ
  tabChat: $("tab-chat"),
  tabAvatar: $("tab-avatar"),
  tabTts: $("tab-tts"),
  tabLine: $("tab-line"),
  panelChat: $("panel-chat"),
  panelAvatar: $("panel-avatar"),
  panelTts: $("panel-tts"),
  panelLine: $("panel-line"),
  modelBadge: $("model-badge"),
  geminiBadge: $("gemini-badge"),
  personaBtn: $("persona-btn"),

  // 共通コントロール
  voice: $("voice-select"),
  avatarSelect: $("avatar-select"),
  speed: $("speed-range"),
  speedValue: $("speed-value"),

  // チャット
  chatMessages: $("chat-messages"),
  chatInput: $("chat-input"),
  micChatBtn: $("mic-chat-btn"),
  sendChatBtn: $("send-chat-btn"),
  enableTtsToggle: $("enable-tts-toggle"),

  // リアル顔アバターステージ & 全画面UI
  avatarCanvas: $("avatar-canvas"),
  avatarStage: $("avatar-stage"),
  avatarStateBadge: $("avatar-state-badge"),
  avatarStyleBtn: $("avatar-style-btn"),
  avatarTestBtn: $("avatar-test-btn"),
  avatarWireframeBtn: $("avatar-wireframe-btn"),
  openAvatarTabBtn: $("open-avatar-tab-btn"),
  avatarFullscreenBtn: $("avatar-fullscreen-btn"),
  exitFullscreenBtn: $("exit-fullscreen-btn"),
  fsAvatarName: $("fs-avatar-name"),
  fsChatInput: $("fs-chat-input"),
  fsMicBtn: $("fs-mic-btn"),
  fsSendBtn: $("fs-send-btn"),

  // アバター作成スタジオ
  avatarNameInput: $("avatar-name-input"),
  webcamOpenBtn: $("webcam-open-btn"),
  webcamBox: $("webcam-box"),
  webcamVideo: $("webcam-video"),
  captureBaseBtn: $("capture-base-btn"),
  captureOpenBtn: $("capture-open-btn"),
  captureSmileBtn: $("capture-smile-btn"),
  webcamCloseBtn: $("webcam-close-btn"),
  slotBase: $("slot-base"),
  slotOpen: $("slot-open"),
  slotSmile: $("slot-smile"),
  previewBase: $("preview-base"),
  previewOpen: $("preview-open"),
  previewSmile: $("preview-smile"),
  fileBase: $("file-base"),
  fileOpen: $("file-open"),
  fileSmile: $("file-smile"),
  vtuberStyleSelect: $("vtuber-style-select"),
  generateVtuberBtn: $("generate-vtuber-btn"),
  calibCanvas: $("calib-canvas"),
  redetectLandmarksBtn: $("redetect-landmarks-btn"),
  landmarkStatus: $("landmark-status"),
  sliderAvatarStyle: $("slider-avatar-style"),
  valAvatarStyle: $("val-avatar-style"),
  sliderVtuberCheek: $("slider-vtuber-cheek"),
  valVtuberCheek: $("val-vtuber-cheek"),
  sliderVtuberShine: $("slider-vtuber-shine"),
  valVtuberShine: $("val-vtuber-shine"),
  sliderMouthSens: $("slider-mouth-sens"),
  valMouthSens: $("val-mouth-sens"),
  sliderHeadMotion: $("slider-head-motion"),
  valHeadMotion: $("val-head-motion"),
  sliderDepthScale: $("slider-depth-scale"),
  valDepthScale: $("val-depth-scale"),
  sliderBlinkRate: $("slider-blink-rate"),
  valBlinkRate: $("val-blink-rate"),
  saveAvatarBtn: $("save-avatar-btn"),
  deleteAvatarBtn: $("delete-avatar-btn"),

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
  lineBadge: $("line-badge"),
  lineConfigStatus: $("line-config-status"),
  lineTotalCount: $("line-total-count"),
  lineUnlearnedCount: $("line-unlearned-count"),
  lineLearnBtn: $("line-learn-btn"),
  lineRefreshBtn: $("line-refresh-btn"),
  webhookUrlCode: $("webhook-url-code"),
  copyWebhookBtn: $("copy-webhook-btn"),
  lineLogsList: $("line-logs-list"),
  lineLogsBadge: $("line-logs-badge"),

  toast: $("toast"),
};

const MAX_HISTORY = 20;
const STORAGE_KEY = "mirai-voice:last-voice";
const AVATAR_STORAGE_KEY = "mirai-voice:last-avatar";

let maxLength = 1000;
let history = []; // { id, text, voice, url, filename, createdAt }
let chatHistory = []; // { role: "user" | "model", text: string }
let activeId = null;
let audioCtx = null;
let analyser = null;
let freqData = null;

// アバター管理状態
let avatarEngine = null;
let savedAvatars = [];
let studioDraft = {
  photos: { base: null, open: null, smile: null, vtuber: null },
  anchors: null,
  detectedBy: "",
};
let webcamStream = null;

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
  if (!input) return;
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

function updateAvatarStateUI(mode, subtitleText = null) {
  if (!els.avatarStateBadge) return;
  els.avatarStateBadge.classList.remove("is-thinking", "is-speaking");
  if (mode === "thinking") {
    els.avatarStateBadge.textContent = "思考中...";
    els.avatarStateBadge.classList.add("is-thinking");
  } else if (mode === "speaking") {
    els.avatarStateBadge.textContent = "🔊 発話中";
    els.avatarStateBadge.classList.add("is-speaking");
  } else {
    els.avatarStateBadge.textContent = "待機中";
  }
  if (avatarEngine) {
    avatarEngine.setMode(mode, subtitleText || "");
  }
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
    { btn: els.tabAvatar, panel: els.panelAvatar },
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
  } else if (targetBtn === els.tabAvatar) {
    drawCalibrationCanvas();
  } else {
    stopWebcam();
  }
}

els.tabChat.addEventListener("click", () => {
  switchTab(els.tabChat, els.panelChat);
  els.chatInput.focus();
});

if (els.tabAvatar) {
  els.tabAvatar.addEventListener("click", () => {
    switchTab(els.tabAvatar, els.panelAvatar);
  });
}

if (els.openAvatarTabBtn) {
  els.openAvatarTabBtn.addEventListener("click", () => {
    if (document.body.classList.contains("is-avatar-fullscreen")) {
      toggleAvatarFullscreen(false);
    }
    switchTab(els.tabAvatar, els.panelAvatar);
  });
}

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
        els.lineBadge.className = "badge badge-ok";
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
    if (els.lineLogsBadge) els.lineLogsBadge.textContent = `${data.total_logs} 件`;

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

    const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
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
    } catch (e) {
      showToast(e.message);
    } finally {
      els.lineLearnBtn.disabled = false;
      els.lineLearnBtn.classList.remove("is-loading");
      els.lineLearnBtn.querySelector(".btn-label").textContent = "✨ LINE会話からAI人格を学習・更新";
    }
  });
}

/* ---------- オーディオグラフ & ストリーミングキュー再生 ---------- */

// ストリーミング再生用の専用 Audio 要素（Web Audio API の AnalyserNode に接続してアバターの口パクを駆動）
const streamAudioEl = new Audio();
streamAudioEl.preload = "auto";
let streamSourceConnected = false;

function ensureAudioGraph() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    freqData = new Uint8Array(analyser.frequencyBinCount);

    audioCtx.createMediaElementSource(els.audio).connect(analyser);
    audioCtx.createMediaElementSource(streamAudioEl).connect(analyser);
    streamSourceConnected = true;
    analyser.connect(audioCtx.destination);

    if (avatarEngine) {
      avatarEngine.connectAudioAnalyser(
        analyser,
        () => (!els.audio.paused && !els.audio.ended) || audioQueue.isPlaying
      );
    }
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
}

class AudioQueuePlayer {
  constructor() {
    this.queue = [];
    this.isPlaying = false;
    this.onStateChange = null;

    streamAudioEl.addEventListener("ended", () => {
      this.playNext();
    });
    streamAudioEl.addEventListener("error", (e) => {
      console.warn("セグメント再生エラー:", e);
      this.playNext();
    });
  }

  enqueue(item) {
    this.queue.push(item);
    if (!this.isPlaying) {
      this.playNext();
    }
  }

  clear() {
    this.queue = [];
    streamAudioEl.pause();
    streamAudioEl.removeAttribute("src");
    this.isPlaying = false;
  }

  playNext() {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      if (this.onStateChange) this.onStateChange(false, null);
      return;
    }

    ensureAudioGraph();
    this.isPlaying = true;
    const current = this.queue.shift();
    if (this.onStateChange) this.onStateChange(true, current);

    streamAudioEl.src = current.url;
    streamAudioEl.play().catch((err) => {
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
    const speakerName = els.voice.value || "AI";
    els.nowPlaying.textContent = `${speakerName}: ${current.text}`;
    updateAvatarStateUI("speaking", current.text);
  } else {
    els.nowPlaying.textContent = "待機中";
    updateAvatarStateUI("idle", "");
  }
};

/* ---------- AI対話 (Chat - ストリーミング版) ---------- */

function setChatLoading(loading) {
  els.sendChatBtn.disabled = loading;
  els.sendChatBtn.classList.toggle("is-loading", loading);
  if (els.fsSendBtn) els.fsSendBtn.disabled = loading;

  const withTts = els.enableTtsToggle ? els.enableTtsToggle.checked : false;
  els.sendChatBtn.querySelector(".btn-label").textContent = loading
    ? (withTts ? "思考＆発話中..." : "思考中...")
    : "話す";
  if (loading) {
    els.nowPlaying.textContent = withTts ? "思考中＆音声生成中..." : "考え中...";
    updateAvatarStateUI("thinking");
  }
}

async function sendChat(overrideMessage = null) {
  const rawInput = overrideMessage !== null ? overrideMessage : els.chatInput.value;
  const message = String(rawInput || "").trim();
  const voice = els.voice.value;

  if (!message) return;
  if (!voice) {
    showToast("声を選択してください。");
    return;
  }

  const enableTts = els.enableTtsToggle ? els.enableTtsToggle.checked : false;

  ensureAudioGraph();
  setChatLoading(true);

  appendChatBubble("user", message);
  els.chatInput.value = "";
  if (els.fsChatInput) els.fsChatInput.value = "";

  const speed = Number(els.speed.value);

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
      buffer = lines.pop();

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
          if (!enableTts) {
            els.nowPlaying.textContent = fullReplyText;
          }
        } else if (payload.type === "audio_segment") {
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

          const timing = payload.timing;
          if (timing) {
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

            addHistory({
              id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
              text: fullReplyText,
              voice: payload.voice,
              url: audioSegments[0].url,
              filename: `tts_${timestampForFile(new Date())}.mp3`,
              createdAt: new Date(),
            });
          } else {
            // TTSがOFFだった場合でも、アバターに口パクシミュレーションで喋らせる
            if (avatarEngine) {
              avatarEngine.triggerTestSpeak(fullReplyText);
            }
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
    updateAvatarStateUI("idle");
  } finally {
    setChatLoading(false);
    if (!audioQueue.isPlaying) {
      updateAvatarStateUI("idle");
    }
    if (document.body.classList.contains("is-avatar-fullscreen")) {
      if (els.fsChatInput) els.fsChatInput.focus();
    } else {
      els.chatInput.focus();
    }
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
  if (loading) {
    els.nowPlaying.textContent = "音声を生成しています...";
    updateAvatarStateUI("thinking");
  }
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
    updateAvatarStateUI("idle");
    showToast(e.message);
  } finally {
    setTtsLoading(false);
  }
}

/* ---------- 再生コントロール ---------- */

function playItem(item) {
  audioQueue.clear();
  ensureAudioGraph();
  activeId = item.id;
  els.audio.src = item.url;
  els.audio.play().catch(() => showToast("自動再生がブロックされました。再生ボタンを押してください。"));
  els.nowPlaying.textContent = `${item.voice}：${item.text}`;
  updateAvatarStateUI("speaking", item.text);
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

els.audio.addEventListener("play", () => {
  els.playBtn.classList.add("is-playing");
  const activeItem = history.find((h) => h.id === activeId);
  updateAvatarStateUI("speaking", activeItem ? activeItem.text : "");
});
els.audio.addEventListener("pause", () => {
  els.playBtn.classList.remove("is-playing");
  if (!audioQueue.isPlaying) updateAvatarStateUI("idle");
});
els.audio.addEventListener("ended", () => {
  els.playBtn.classList.remove("is-playing");
  if (!audioQueue.isPlaying) updateAvatarStateUI("idle");
});
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
  audioQueue.clear();
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
  updateAvatarStateUI("idle");
  renderHistory();
}

/* ---------- ビジュアライザー ---------- */

const ctx2d = els.canvas.getContext("2d");

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = els.canvas.getBoundingClientRect();
  if (width === 0 || height === 0) return;
  els.canvas.width = Math.round(width * dpr);
  els.canvas.height = Math.round(height * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw(t) {
  const { width, height } = els.canvas.getBoundingClientRect();
  if (width > 0 && height > 0) {
    ctx2d.clearRect(0, 0, width, height);

    const bars = 48;
    const gap = 3;
    const barW = (width - gap * (bars - 1)) / bars;
    const mid = height * 0.5;
    const playing = analyser && (!els.audio.paused || audioQueue.isPlaying);

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
        level = 0.08 + 0.05 * Math.sin(t / 600 + i * 0.35);
      }
      const h = Math.max(2, level * (height * 0.82));
      const x = i * (barW + gap);
      ctx2d.globalAlpha = 0.95;
      roundRect(x, mid - h / 2, barW, h, barW / 2);
    }
    ctx2d.globalAlpha = 1;
  }
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

/* ---------- Face Mirror アバター管理 & スタジオ機能 ---------- */

function initAvatarEngine() {
  if (!els.avatarCanvas || !window.FaceMirrorEngine) return;
  avatarEngine = new window.FaceMirrorEngine.FaceMirrorAvatar(els.avatarCanvas);
  studioDraft.anchors = JSON.parse(JSON.stringify(avatarEngine.anchors));
  loadAvatarsList();
}

async function loadAvatarsList(selectId = null) {
  try {
    const res = await fetch("/api/avatars");
    const data = await res.json();
    savedAvatars = data.avatars || [];

    els.avatarSelect.innerHTML = "";
    const demoOpt = document.createElement("option");
    demoOpt.value = "demo";
    demoOpt.textContent = "デモアバター（初期）";
    els.avatarSelect.append(demoOpt);

    for (const av of savedAvatars) {
      const opt = document.createElement("option");
      opt.value = av.id;
      opt.textContent = `${av.name} (${av.photo_count || 1}枚)`;
      els.avatarSelect.append(opt);
    }

    const targetId = selectId || localStorage.getItem(AVATAR_STORAGE_KEY) || (savedAvatars[0] && savedAvatars[0].id) || "demo";
    if (targetId !== "demo" && savedAvatars.some((a) => a.id === targetId)) {
      els.avatarSelect.value = targetId;
      await applySelectedAvatar(targetId);
    } else {
      els.avatarSelect.value = "demo";
      await applySelectedAvatar("demo");
    }
  } catch (e) {
    console.warn("アバター一覧の読み込み失敗:", e);
  }
}

async function applySelectedAvatar(avatarId) {
  if (!avatarEngine) return;
  localStorage.setItem(AVATAR_STORAGE_KEY, avatarId);

  if (avatarId === "demo") {
    await avatarEngine.loadAvatarData(null);
    if (els.fsAvatarName) els.fsAvatarName.textContent = "デモアバター（対話モード）";
    studioDraft.anchors = JSON.parse(JSON.stringify(avatarEngine.anchors));
    drawCalibrationCanvas();
    return;
  }

  const found = savedAvatars.find((a) => a.id === avatarId);
  if (!found) return;

  await avatarEngine.loadAvatarData(found);
  if (els.fsAvatarName) els.fsAvatarName.textContent = `${found.name}（ライブ対話中）`;

  // スタジオ側のフォームにも反映
  els.avatarNameInput.value = found.name || "マイリアルアバター";
  studioDraft.photos = {
    base: found.photos.base || null,
    open: found.photos.open || null,
    smile: found.photos.smile || null,
  };
  studioDraft.anchors = JSON.parse(JSON.stringify(avatarEngine.anchors));
  renderSlotPreview("base", studioDraft.photos.base);
  renderSlotPreview("open", studioDraft.photos.open);
  renderSlotPreview("smile", studioDraft.photos.smile);
  syncSlidersFromAvatar();
  drawCalibrationCanvas();
}

function syncSlidersFromAvatar() {
  if (!avatarEngine) return;
  const s = avatarEngine.settings;
  syncAvatarStyleUI(s.avatarStyle || "vtuber");
  if (els.sliderVtuberCheek && s.vtuberCheek !== undefined) {
    els.sliderVtuberCheek.value = s.vtuberCheek;
    if (els.valVtuberCheek) els.valVtuberCheek.textContent = `${Number(s.vtuberCheek).toFixed(2)}x`;
    setRangeFill(els.sliderVtuberCheek);
  }
  if (els.sliderVtuberShine && s.vtuberEyeShine !== undefined) {
    els.sliderVtuberShine.value = s.vtuberEyeShine;
    if (els.valVtuberShine) els.valVtuberShine.textContent = `${Number(s.vtuberEyeShine).toFixed(2)}x`;
    setRangeFill(els.sliderVtuberShine);
  }
  if (els.sliderMouthSens) {
    els.sliderMouthSens.value = s.mouthSensitivity;
    els.valMouthSens.textContent = `${Number(s.mouthSensitivity).toFixed(2)}x`;
    setRangeFill(els.sliderMouthSens);
  }
  if (els.sliderHeadMotion) {
    els.sliderHeadMotion.value = s.headMotionScale;
    els.valHeadMotion.textContent = `${Number(s.headMotionScale).toFixed(2)}x`;
    setRangeFill(els.sliderHeadMotion);
  }
  if (els.sliderDepthScale) {
    els.sliderDepthScale.value = s.depthScale;
    els.valDepthScale.textContent = `${Number(s.depthScale).toFixed(2)}x`;
    setRangeFill(els.sliderDepthScale);
  }
  if (els.sliderBlinkRate) {
    els.sliderBlinkRate.value = s.blinkRate;
    els.valBlinkRate.textContent = `${Number(s.blinkRate).toFixed(2)}x`;
    setRangeFill(els.sliderBlinkRate);
  }
}

function renderSlotPreview(slotKey, dataUrlOrPath) {
  const previewEl =
    slotKey === "base" ? els.previewBase : slotKey === "open" ? els.previewOpen : els.previewSmile;
  if (!previewEl) return;

  if (!dataUrlOrPath) {
    const placeholders = {
      base: '👤<br>正面の顔写真<br><small>クリックまたはドロップ</small>',
      open: '😮<br>口を少し開けた写真<br><small>口内のリアルさ向上</small>',
      smile: '😊<br>笑顔の写真<br><small>会話中の表情変化用</small>',
    };
    previewEl.innerHTML = `<span class="slot-placeholder">${placeholders[slotKey]}</span>`;
    return;
  }

  previewEl.innerHTML = "";
  const img = document.createElement("img");
  img.src = dataUrlOrPath;
  img.alt = slotKey;
  previewEl.append(img);
}

/**
 * 読み込んだ画像ファイルを正方形720x720 DataURLに正規化してスタジオにセット
 */
async function handleSlotImageFile(slotKey, file) {
  if (!file || !file.type.startsWith("image/")) {
    showToast("画像ファイルを選択してください。");
    return;
  }
  const reader = new FileReader();
  const rawDataUrl = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  await setSlotImageDataUrl(slotKey, rawDataUrl);
}

async function setSlotImageDataUrl(slotKey, rawDataUrl) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = rawDataUrl;
  });

  // 720x720 正方形ポートレートに正規化
  const normCanvas = avatarEngine
    ? avatarEngine._normalizePortraitImage(img)
    : (() => {
        const c = document.createElement("canvas");
        c.width = 720;
        c.height = 720;
        c.getContext("2d").drawImage(img, 0, 0, 720, 720);
        return c;
      })();

  const normalizedDataUrl = normCanvas.toDataURL("image/jpeg", 0.92);
  studioDraft.photos[slotKey] = normalizedDataUrl;
  renderSlotPreview(slotKey, normalizedDataUrl);

  // ベース写真が設定されたら即座に3D顔ランドマークを自動検出し、右側のライブアバターにもリアルタイム反映！
  if (slotKey === "base") {
    els.landmarkStatus.textContent = "⏳ 顔の3Dメッシュ・ランドマークを自動解析中...";
    const detection = await window.FaceMirrorEngine.detectFaceAnchors(normCanvas);
    studioDraft.anchors = detection.anchors;
    studioDraft.detectedBy = detection.detectedBy;
    els.landmarkStatus.textContent =
      detection.detectedBy === "mediapipe-478"
        ? "✅ AI 478点3D顔メッシュの自動生成が完了しました！（ドラッグで微調整も可能）"
        : "✅ 顔メッシュを生成しました（必要に応じて緑の点をドラッグして目・口の位置を合わせてください）";
  }

  // 右ペインのライブアバターで即プレビュー可能にする
  if (avatarEngine && studioDraft.photos.base) {
    await avatarEngine.loadAvatarData({
      name: els.avatarNameInput.value || "プレビューアバター",
      photos: studioDraft.photos,
      landmarks: { anchors: studioDraft.anchors },
      settings: avatarEngine.settings,
    });
    drawCalibrationCanvas();
    avatarEngine.triggerTestSpeak("写真を読み込んだよ！口パクの動きはどうかな？");
  }
}


/* ---------- Vtuber アバター自動生成 & スタイル切り替え ---------- */

async function generateAndApplyVtuberAvatar(canvasOrImg = null) {
  if (!window.FaceMirrorEngine || !window.FaceMirrorEngine.generateVtuberAvatar) return;
  const source = canvasOrImg || avatarEngine?.images?.base;
  if (!source) {
    showToast("先に正面の顔写真をアップロードまたは撮影してください");
    return;
  }

  if (els.generateVtuberBtn) {
    els.generateVtuberBtn.disabled = true;
    els.generateVtuberBtn.classList.add("is-loading");
    els.generateVtuberBtn.querySelector(".btn-label").textContent = "Vtuberアバターを生成中...";
  }

  try {
    const anchors = studioDraft.anchors || avatarEngine?.anchors;
    const vtuberCanvas = window.FaceMirrorEngine.generateVtuberAvatar(source, anchors);
    const vtuberDataUrl = vtuberCanvas.toDataURL("image/png");
    studioDraft.photos.vtuber = vtuberDataUrl;

    if (avatarEngine) {
      avatarEngine.settings.avatarStyle = "vtuber";
      await avatarEngine.loadAvatarData({
        name: els.avatarNameInput.value || "マイVtuberアバター",
        photos: studioDraft.photos,
        landmarks: { anchors: studioDraft.anchors },
        settings: avatarEngine.settings,
      });
      avatarEngine.triggerTestSpeak("あなたの顔写真を基に、Vtuberアバターを作ったよ！どうかな？");
    }

    syncAvatarStyleUI("vtuber");
    showToast("✨ 写真を基に、あなたそっくりのVtuberアバターを生成しました！");
  } catch (err) {
    console.error("Vtuber生成失敗:", err);
    showToast("Vtuberアバターの生成中にエラーが発生しました: " + err.message);
  } finally {
    if (els.generateVtuberBtn) {
      els.generateVtuberBtn.disabled = false;
      els.generateVtuberBtn.classList.remove("is-loading");
      els.generateVtuberBtn.querySelector(".btn-label").textContent = "✨ 写真からVtuberアバターを生成";
    }
  }
}

function syncAvatarStyleUI(style) {
  if (avatarEngine) {
    avatarEngine.settings.avatarStyle = style;
  }
  if (els.avatarStyleBtn) {
    els.avatarStyleBtn.textContent = style === "vtuber" ? "🌟 Vtuber" : "📸 リアル写真";
  }
  if (els.sliderAvatarStyle) {
    els.sliderAvatarStyle.value = style;
  }
  if (els.valAvatarStyle) {
    els.valAvatarStyle.textContent = style === "vtuber" ? "Vtuber" : "リアル写真";
  }
  if (els.vtuberStyleSelect) {
    els.vtuberStyleSelect.value = style;
  }
}

/* ---------- ランドマーク微調整キャンバス (#calib-canvas) ---------- */

const CALIB_HANDLE_KEYS = [
  { key: "leftEyeTop", label: "左目", color: "#38bdf8" },
  { key: "rightEyeTop", label: "右目", color: "#38bdf8" },
  { key: "noseTip", label: "鼻先", color: "#a855f7" },
  { key: "mouthLeft", label: "左口角", color: "#22c55e" },
  { key: "mouthRight", label: "右口角", color: "#22c55e" },
  { key: "upperLipTop", label: "上唇", color: "#f43f5e" },
  { key: "lipCenter", label: "口中央", color: "#fbbf24" },
  { key: "lowerLipBottom", label: "下唇", color: "#f43f5e" },
  { key: "chin", label: "顎先", color: "#e879f9" },
];

let draggingHandleKey = null;

function drawCalibrationCanvas() {
  if (!els.calibCanvas || !avatarEngine) return;
  const canvas = els.calibCanvas;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // 背景に現在のベース画像を描画
  const baseImg = avatarEngine.images.base;
  if (baseImg) {
    ctx.drawImage(baseImg, 0, 0, W, H);
  }

  // 半透明オーバーレイ
  ctx.fillStyle = "rgba(8, 10, 22, 0.25)";
  ctx.fillRect(0, 0, W, H);

  // 三角形メッシュを細線で表示
  const anchors = studioDraft.anchors || avatarEngine.anchors;
  const previewMesh = window.FaceMirrorEngine.buildRiggedFaceMesh(anchors);
  ctx.strokeStyle = "rgba(56, 189, 248, 0.35)";
  ctx.lineWidth = 0.8;
  for (const [i0, i1, i2] of previewMesh.triangles) {
    const v0 = previewMesh.vertices[i0];
    const v1 = previewMesh.vertices[i1];
    const v2 = previewMesh.vertices[i2];
    if (v0.role === "bg" && v1.role === "bg" && v2.role === "bg") continue;
    ctx.beginPath();
    ctx.moveTo(v0.u * W, v0.v * H);
    ctx.lineTo(v1.u * W, v1.v * H);
    ctx.lineTo(v2.u * W, v2.v * H);
    ctx.closePath();
    ctx.stroke();
  }

  // 主要調整ハンドルを描画
  for (const h of CALIB_HANDLE_KEYS) {
    const pt = anchors[h.key];
    if (!pt) continue;
    const px = pt.x * W;
    const py = pt.y * H;

    ctx.beginPath();
    ctx.arc(px, py, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = h.color;
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }
}

function initCalibrationDrag() {
  if (!els.calibCanvas) return;
  const canvas = els.calibCanvas;

  const getPointerNorm = (e) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0.05, Math.min(0.95, (e.clientY - rect.top) / rect.height)),
    };
  };

  canvas.addEventListener("pointerdown", (e) => {
    const pos = getPointerNorm(e);
    const anchors = studioDraft.anchors || avatarEngine.anchors;
    let bestKey = null;
    let bestDist = 0.06;

    for (const h of CALIB_HANDLE_KEYS) {
      const pt = anchors[h.key];
      if (!pt) continue;
      const d = Math.hypot(pt.x - pos.x, pt.y - pos.y);
      if (d < bestDist) {
        bestDist = d;
        bestKey = h.key;
      }
    }

    if (bestKey) {
      draggingHandleKey = bestKey;
      canvas.setPointerCapture(e.pointerId);
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!draggingHandleKey) return;
    const pos = getPointerNorm(e);
    const anchors = studioDraft.anchors || avatarEngine.anchors;
    const prev = anchors[draggingHandleKey];
    const dx = pos.x - prev.x;
    const dy = pos.y - prev.y;
    anchors[draggingHandleKey] = { x: pos.x, y: pos.y };

    // 目の上まぶたを動かしたときは下まぶた・目頭・目尻も連動して移動しやすくする
    if (draggingHandleKey === "leftEyeTop") {
      anchors.leftEyeBottom.x += dx;
      anchors.leftEyeBottom.y += dy;
      anchors.leftEyeOuter.x += dx;
      anchors.leftEyeOuter.y += dy;
      anchors.leftEyeInner.x += dx;
      anchors.leftEyeInner.y += dy;
    } else if (draggingHandleKey === "rightEyeTop") {
      anchors.rightEyeBottom.x += dx;
      anchors.rightEyeBottom.y += dy;
      anchors.rightEyeOuter.x += dx;
      anchors.rightEyeOuter.y += dy;
      anchors.rightEyeInner.x += dx;
      anchors.rightEyeInner.y += dy;
    }

    avatarEngine.updateAnchors(anchors);
    drawCalibrationCanvas();
  });

  const endDrag = () => {
    draggingHandleKey = null;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
}

/* ---------- Webカメラ撮影機能 ---------- */

async function startWebcam() {
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 720 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    els.webcamVideo.srcObject = webcamStream;
    els.webcamBox.classList.remove("is-hidden");
  } catch (e) {
    showToast("Webカメラにアクセスできませんでした。カメラの許可設定を確認してください。");
  }
}

function stopWebcam() {
  if (webcamStream) {
    for (const track of webcamStream.getTracks()) track.stop();
    webcamStream = null;
  }
  if (els.webcamVideo) els.webcamVideo.srcObject = null;
  if (els.webcamBox) els.webcamBox.classList.add("is-hidden");
}

async function captureFromWebcam(slotKey) {
  if (!webcamStream || !els.webcamVideo.videoWidth) {
    showToast("カメラ映像がまだ準備できていません。");
    return;
  }
  const vw = els.webcamVideo.videoWidth;
  const vh = els.webcamVideo.videoHeight;
  const size = Math.min(vw, vh);
  const sx = (vw - size) * 0.5;
  const sy = (vh - size) * 0.5;

  const c = document.createElement("canvas");
  c.width = 720;
  c.height = 720;
  const ctx = c.getContext("2d");
  // ミラー反転して描画
  ctx.translate(720, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(els.webcamVideo, sx, sy, size, size, 0, 0, 720, 720);

  const dataUrl = c.toDataURL("image/jpeg", 0.92);
  await setSlotImageDataUrl(slotKey, dataUrl);
  showToast(
    slotKey === "base"
      ? "① ベース顔写真を撮影しました！"
      : slotKey === "open"
      ? "② 口開け写真を撮影しました！"
      : "③ 笑顔写真を撮影しました！"
  );
}

/* ---------- アバター保存・削除 ---------- */

async function saveCurrentAvatar() {
  if (!studioDraft.photos.base) {
    showToast("少なくとも「① ベース顔（正面写真）」を1枚登録してください。");
    return;
  }

  const name = (els.avatarNameInput.value || "").trim() || "マイリアルアバター";
  els.saveAvatarBtn.disabled = true;
  els.saveAvatarBtn.classList.add("is-loading");

  try {
    const payload = {
      name,
      photos: studioDraft.photos,
      landmarks: {
        anchors: studioDraft.anchors || avatarEngine.anchors,
        detectedBy: studioDraft.detectedBy || "manual",
      },
      settings: avatarEngine ? avatarEngine.settings : {},
    };

    const currentSelected = els.avatarSelect.value;
    const isUpdatingExisting =
      currentSelected &&
      currentSelected !== "demo" &&
      savedAvatars.some((a) => a.id === currentSelected && a.name === name);

    const url = isUpdatingExisting ? `/api/avatars/${currentSelected}` : "/api/avatars";
    const method = isUpdatingExisting ? "PUT" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "アバターの保存に失敗しました");

    showToast(`アバター「${data.avatar.name}」を保存して適用しました！`);
    stopWebcam();
    await loadAvatarsList(data.avatar.id);
  } catch (e) {
    showToast(e.message);
  } finally {
    els.saveAvatarBtn.disabled = false;
    els.saveAvatarBtn.classList.remove("is-loading");
  }
}

async function deleteSelectedAvatar() {
  const currentId = els.avatarSelect.value;
  if (!currentId || currentId === "demo") {
    showToast("デモアバターは削除できません。");
    return;
  }
  try {
    const res = await fetch(`/api/avatars/${currentId}`, { method: "DELETE" });
    if (!res.ok) throw new Error("削除に失敗しました");
    showToast("アバターを削除しました。");
    studioDraft.photos = { base: null, open: null, smile: null };
    renderSlotPreview("base", null);
    renderSlotPreview("open", null);
    renderSlotPreview("smile", null);
    await loadAvatarsList("demo");
  } catch (e) {
    showToast(e.message);
  }
}

/* ---------- 全画面ビデオ通話モード & 音声入力 (Web Speech API) ---------- */

function toggleAvatarFullscreen(forceState = null) {
  const next =
    typeof forceState === "boolean"
      ? forceState
      : !document.body.classList.contains("is-avatar-fullscreen");
  document.body.classList.toggle("is-avatar-fullscreen", next);
  if (els.avatarFullscreenBtn) {
    els.avatarFullscreenBtn.classList.toggle("is-active", next);
  }
  if (next && els.fsChatInput) {
    setTimeout(() => els.fsChatInput.focus(), 100);
  }
}

function initSpeechRecognition() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    const warnNoSpeech = () =>
      showToast("お使いのブラウザは音声認識に対応していません（Chrome / Edge でご利用いただけます）");
    if (els.micChatBtn) els.micChatBtn.addEventListener("click", warnNoSpeech);
    if (els.fsMicBtn) els.fsMicBtn.addEventListener("click", warnNoSpeech);
    return;
  }

  const rec = new SpeechRec();
  rec.lang = "ja-JP";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  let isRecording = false;

  const setRecUI = (active) => {
    isRecording = active;
    if (els.micChatBtn) els.micChatBtn.classList.toggle("is-recording", active);
    if (els.fsMicBtn) els.fsMicBtn.classList.toggle("is-recording", active);
  };

  rec.onresult = (event) => {
    const transcript = event.results[0] && event.results[0][0] ? event.results[0][0].transcript.trim() : "";
    if (transcript) {
      sendChat(transcript);
    }
  };
  rec.onerror = () => setRecUI(false);
  rec.onend = () => setRecUI(false);

  const toggleMic = () => {
    if (isRecording) {
      rec.stop();
      setRecUI(false);
    } else {
      try {
        rec.start();
        setRecUI(true);
        showToast("🎤 話しかけてください...");
      } catch {
        setRecUI(false);
      }
    }
  };

  if (els.micChatBtn) els.micChatBtn.addEventListener("click", toggleMic);
  if (els.fsMicBtn) els.fsMicBtn.addEventListener("click", toggleMic);
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
els.sendChatBtn.addEventListener("click", () => sendChat());

// 全画面チャットバーの送信イベント
if (els.fsChatInput) {
  els.fsChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!els.sendChatBtn.disabled) sendChat(els.fsChatInput.value);
    }
  });
}
if (els.fsSendBtn) {
  els.fsSendBtn.addEventListener("click", () => {
    if (!els.sendChatBtn.disabled) sendChat(els.fsChatInput.value);
  });
}

// アバターツールバーボタン
if (els.avatarTestBtn) {
  els.avatarTestBtn.addEventListener("click", () => {
    if (avatarEngine) {
      avatarEngine.triggerTestSpeak("こんにちは！こんな感じで声に合わせてリアルに口と顔が動くよ！");
      els.nowPlaying.textContent = "テスト発話中: こんにちは！こんな感じで声に合わせてリアルに口と顔が動くよ！";
    }
  });
}

if (els.avatarWireframeBtn) {
  els.avatarWireframeBtn.addEventListener("click", () => {
    if (!avatarEngine) return;
    avatarEngine.settings.showWireframe = !avatarEngine.settings.showWireframe;
    els.avatarWireframeBtn.classList.toggle("is-active", avatarEngine.settings.showWireframe);
  });
}

if (els.avatarFullscreenBtn) {
  els.avatarFullscreenBtn.addEventListener("click", () => toggleAvatarFullscreen());
}
if (els.exitFullscreenBtn) {
  els.exitFullscreenBtn.addEventListener("click", () => toggleAvatarFullscreen(false));
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("is-avatar-fullscreen")) {
    toggleAvatarFullscreen(false);
  }
});

if (els.avatarSelect) {
  els.avatarSelect.addEventListener("change", () => {
    applySelectedAvatar(els.avatarSelect.value);
  });
}

// アバタースタジオ：スロットクリック＆ドラッグ＆ドロップ
const bindPhotoSlot = (slotKey, previewEl, fileInputEl, slotCardEl) => {
  if (!previewEl || !fileInputEl) return;
  previewEl.addEventListener("click", () => fileInputEl.click());
  fileInputEl.addEventListener("change", () => {
    if (fileInputEl.files && fileInputEl.files[0]) {
      handleSlotImageFile(slotKey, fileInputEl.files[0]);
      fileInputEl.value = "";
    }
  });
  if (slotCardEl) {
    slotCardEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      slotCardEl.style.borderColor = "var(--accent-2)";
    });
    slotCardEl.addEventListener("dragleave", () => {
      slotCardEl.style.borderColor = "";
    });
    slotCardEl.addEventListener("drop", (e) => {
      e.preventDefault();
      slotCardEl.style.borderColor = "";
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleSlotImageFile(slotKey, e.dataTransfer.files[0]);
      }
    });
  }
};

bindPhotoSlot("base", els.previewBase, els.fileBase, els.slotBase);
bindPhotoSlot("open", els.previewOpen, els.fileOpen, els.slotOpen);
bindPhotoSlot("smile", els.previewSmile, els.fileSmile, els.slotSmile);

document.querySelectorAll(".slot-clear-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const slot = btn.dataset.slot;
    studioDraft.photos[slot] = null;
    renderSlotPreview(slot, null);
  });
});

if (els.webcamOpenBtn) els.webcamOpenBtn.addEventListener("click", startWebcam);
if (els.webcamCloseBtn) els.webcamCloseBtn.addEventListener("click", stopWebcam);
if (els.captureBaseBtn) els.captureBaseBtn.addEventListener("click", () => captureFromWebcam("base"));
if (els.captureOpenBtn) els.captureOpenBtn.addEventListener("click", () => captureFromWebcam("open"));
if (els.captureSmileBtn) els.captureSmileBtn.addEventListener("click", () => captureFromWebcam("smile"));

if (els.redetectLandmarksBtn) {
  els.redetectLandmarksBtn.addEventListener("click", async () => {
    if (!avatarEngine || !avatarEngine.images.base) return;
    els.landmarkStatus.textContent = "⏳ 再検出中...";
    const det = await window.FaceMirrorEngine.detectFaceAnchors(avatarEngine.images.base);
    studioDraft.anchors = det.anchors;
    avatarEngine.updateAnchors(det.anchors);
    drawCalibrationCanvas();
    els.landmarkStatus.textContent = "✅ ランドマークを再検出しました！";
  });
}

// スライダーイベント
const bindAvatarSlider = (sliderEl, outputEl, propName) => {
  if (!sliderEl || !outputEl) return;
  setRangeFill(sliderEl);
  sliderEl.addEventListener("input", () => {
    const val = Number(sliderEl.value);
    outputEl.textContent = `${val.toFixed(2)}x`;
    setRangeFill(sliderEl);
    if (avatarEngine) {
      avatarEngine.settings[propName] = val;
    }
  });
};

bindAvatarSlider(els.sliderMouthSens, els.valMouthSens, "mouthSensitivity");
bindAvatarSlider(els.sliderHeadMotion, els.valHeadMotion, "headMotionScale");
bindAvatarSlider(els.sliderDepthScale, els.valDepthScale, "depthScale");
bindAvatarSlider(els.sliderBlinkRate, els.valBlinkRate, "blinkRate");

// Vtuber用スライダー＆スタイルイベント
if (els.generateVtuberBtn) {
  els.generateVtuberBtn.addEventListener("click", () => generateAndApplyVtuberAvatar());
}

if (els.avatarStyleBtn) {
  els.avatarStyleBtn.addEventListener("click", () => {
    const cur = avatarEngine?.settings?.avatarStyle || "vtuber";
    const next = cur === "vtuber" ? "photomesh" : "vtuber";
    syncAvatarStyleUI(next);
    showToast(next === "vtuber" ? "🌟 Vtuberアバターモードに切り替えました" : "📸 リアル写真メッシュモードに切り替えました");
  });
}

if (els.sliderAvatarStyle) {
  els.sliderAvatarStyle.addEventListener("change", (e) => {
    syncAvatarStyleUI(e.target.value);
  });
}

if (els.vtuberStyleSelect) {
  els.vtuberStyleSelect.addEventListener("change", (e) => {
    syncAvatarStyleUI(e.target.value);
  });
}

bindAvatarSlider(els.sliderVtuberCheek, els.valVtuberCheek, "vtuberCheek");
bindAvatarSlider(els.sliderVtuberShine, els.valVtuberShine, "vtuberEyeShine");

if (els.saveAvatarBtn) els.saveAvatarBtn.addEventListener("click", saveCurrentAvatar);
if (els.deleteAvatarBtn) els.deleteAvatarBtn.addEventListener("click", deleteSelectedAvatar);

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
initAvatarEngine();
initCalibrationDrag();
initSpeechRecognition();
requestAnimationFrame(draw);
loadConfig();
loadVoices();
loadLineStatus();
els.chatInput.focus();

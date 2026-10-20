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

els.tabChat.addEventListener("click", () => {
  els.tabChat.classList.add("is-active");
  els.tabChat.setAttribute("aria-selected", "true");
  els.tabTts.classList.remove("is-active");
  els.tabTts.setAttribute("aria-selected", "false");

  els.panelChat.classList.remove("is-hidden");
  els.panelTts.classList.add("is-hidden");
  els.chatInput.focus();
});

els.tabTts.addEventListener("click", () => {
  els.tabTts.classList.add("is-active");
  els.tabTts.setAttribute("aria-selected", "true");
  els.tabChat.classList.remove("is-active");
  els.tabChat.setAttribute("aria-selected", "false");

  els.panelTts.classList.remove("is-hidden");
  els.panelChat.classList.add("is-hidden");
  els.ttsText.focus();
});

/* ---------- AI対話 (Chat) ---------- */

function setChatLoading(loading) {
  els.sendChatBtn.disabled = loading;
  els.sendChatBtn.classList.toggle("is-loading", loading);
  const withTts = els.enableTtsToggle ? els.enableTtsToggle.checked : false;
  els.sendChatBtn.querySelector(".btn-label").textContent = loading
    ? (withTts ? "思考＆発話中..." : "思考中...")
    : "話す";
  if (loading) els.nowPlaying.textContent = withTts ? "考え中＆音声を生成中..." : "考え中...";
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

  try {
    const res = await fetch("/api/chat", {
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

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    // 会話履歴を更新
    chatHistory.push({ role: "user", text: message });
    chatHistory.push({ role: "model", text: data.reply });

    // 2. AIの吹き出しを追加
    const item = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      text: data.reply,
      voice: data.voice,
      url: data.audio_base64 ? b64ToBlobUrl(data.audio_base64) : null,
      filename: `tts_${timestampForFile(new Date())}.mp3`,
      createdAt: new Date(),
    };

    appendChatBubble("model", data.reply, item);

    if (item.url) {
      addHistory(item);
      playItem(item);
    } else {
      els.nowPlaying.textContent = `市川 拓（たく）：${data.reply}`;
    }
  } catch (e) {
    showToast(e.message);
    appendChatBubble("model", `（エラー: ${e.message}）`);
    els.nowPlaying.textContent = "対話エラー";
  } finally {
    setChatLoading(false);
    els.chatInput.focus();
  }
}

function appendChatBubble(role, text, audioItem = null) {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble chat-bubble-${role === "user" ? "user" : "ai"}`;
  
  const p = document.createElement("p");
  p.textContent = text;
  bubble.append(p);

  if (role === "model") {
    const meta = document.createElement("div");
    meta.className = "bubble-meta";
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
      // まだ音声がない場合：オンデマンドで生成
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
els.chatInput.focus();

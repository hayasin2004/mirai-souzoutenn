"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  voice: $("voice-select"),
  speed: $("speed-range"),
  speedValue: $("speed-value"),
  text: $("tts-text"),
  charCount: $("char-count"),
  speakBtn: $("speak-btn"),
  modelBadge: $("model-badge"),
  audio: $("audio"),
  canvas: $("visualizer"),
  nowPlaying: $("now-playing"),
  playBtn: $("play-btn"),
  seek: $("seek-range"),
  timeCurrent: $("time-current"),
  timeTotal: $("time-total"),
  download: $("download-link"),
  historyList: $("history-list"),
  clearHistory: $("clear-history-btn"),
  toast: $("toast"),
};

const MAX_HISTORY = 20;
const STORAGE_KEY = "mirai-voice:last-voice";

let maxLength = Number(els.text.maxLength) || 1000;
let history = []; // { id, text, voice, url, filename, createdAt }
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
  toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 5000);
}

/* ---------- 声一覧 ---------- */

async function loadVoices() {
  try {
    const res = await fetch("/api/voices");
    const data = await res.json();
    els.modelBadge.textContent = `model: ${data.model}`;
    if (data.max_length) {
      maxLength = data.max_length;
      els.text.maxLength = maxLength;
      updateCharCount();
    }

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

/* ---------- 読み上げ ---------- */

function setLoading(loading) {
  els.speakBtn.disabled = loading;
  els.speakBtn.classList.toggle("is-loading", loading);
  els.speakBtn.querySelector(".btn-label").textContent = loading ? "生成中..." : "読み上げる";
  if (loading) els.nowPlaying.textContent = "音声を生成しています...";
}

async function speak() {
  const text = els.text.value.trim();
  const voice = els.voice.value;
  if (!text) {
    showToast("読み上げる文章を入力してください。");
    els.text.focus();
    return;
  }
  if (!voice) {
    showToast("声を選択してください。");
    return;
  }

  ensureAudioGraph(); // クリック直後に AudioContext を作っておく（自動再生制限対策）
  setLoading(true);

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
    setLoading(false);
  }
}

/* ---------- 再生 ---------- */

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
}

function renderHistory() {
  els.historyList.innerHTML = "";
  if (!history.length) {
    els.historyList.innerHTML = '<li class="history-empty">まだ履歴はありません</li>';
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
  els.nowPlaying.textContent = "文章を入力して「読み上げる」を押してください";
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
      // 低〜中域を中心に使う（声の帯域）
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

/* ---------- 入力まわり ---------- */

function updateCharCount() {
  const len = els.text.value.length;
  els.charCount.textContent = `${len} / ${maxLength}`;
  els.charCount.classList.toggle("is-near", len > maxLength * 0.9);
}

function updateSpeed() {
  els.speedValue.textContent = `${Number(els.speed.value).toFixed(1)}x`;
  setRangeFill(els.speed);
}

els.text.addEventListener("input", updateCharCount);
els.text.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    if (!els.speakBtn.disabled) speak();
  }
});
els.speed.addEventListener("input", updateSpeed);
els.voice.addEventListener("change", () => localStorage.setItem(STORAGE_KEY, els.voice.value));
els.speakBtn.addEventListener("click", speak);
els.playBtn.addEventListener("click", togglePlay);
els.clearHistory.addEventListener("click", clearHistory);
window.addEventListener("resize", resizeCanvas);

/* ---------- 初期化 ---------- */

updateSpeed();
updateCharCount();
setRangeFill(els.seek);
resizeCanvas();
requestAnimationFrame(draw);
loadVoices();
els.text.focus();

"use client";

/**
 * 展示画面の演出（Canvas）。どれも requestAnimationFrame で動き、止める関数を返す。
 * 座標は Canvas の内部解像度（size × size）。
 */

export type Connection = { start: number; end: number };
export type FaceConnections = { tesselation: Connection[]; contours: Connection[]; oval: Connection[] };

let connectionsPromise: Promise<FaceConnections> | null = null;

/** MediaPipe の線のつながりの定数（モデルや WASM は読み込まない） */
export function loadFaceConnections(): Promise<FaceConnections> {
  connectionsPromise ??= import("@mediapipe/tasks-vision").then(({ FaceLandmarker }) => ({
    tesselation: FaceLandmarker.FACE_LANDMARKS_TESSELATION,
    contours: FaceLandmarker.FACE_LANDMARKS_CONTOURS,
    oval: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
  }));
  return connectionsPromise;
}

const HOLO = "127, 227, 255";

function animate(durationMs: number, draw: (t: number) => void, done?: () => void): () => void {
  let raf = 0;
  let start: number | null = null;
  const tick = (now: number) => {
    start ??= now;
    const t = Math.min(1, (now - start) / durationMs);
    draw(t);
    if (t < 1) raf = requestAnimationFrame(tick);
    else done?.();
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/**
 * 顔スキャン演出：上から下へ走査線が走り、通過したところにランドマークの点と線が浮かび、消える。
 * @param landmarks 切り出し画像に対する 0〜1 の [x, y, z]
 */
export function playScan(
  canvas: HTMLCanvasElement,
  landmarks: readonly (readonly [number, number, number])[],
  connections: FaceConnections,
  durationMs = 600,
): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const size = canvas.width;
  const pts = landmarks.map(([x, y]) => [x * size, y * size] as const);
  let top = Infinity;
  let bottom = -Infinity;
  for (const [, y] of pts) {
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  const span = bottom - top || 1;

  return animate(
    durationMs,
    (t) => {
      ctx.clearRect(0, 0, size, size);
      // 0〜0.7 で走査、0.7〜1 で全体が消える
      const sweep = Math.min(1, t / 0.7);
      const fade = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      const scanY = top - 0.05 * span + sweep * span * 1.1;
      const visible = (y: number) => y <= scanY;

      ctx.lineWidth = 0.6;
      ctx.strokeStyle = `rgba(${HOLO}, ${0.22 * fade})`;
      ctx.beginPath();
      for (const { start, end } of connections.tesselation) {
        const a = pts[start];
        const b = pts[end];
        if (!a || !b || !visible(a[1]) || !visible(b[1])) continue;
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();

      ctx.lineWidth = 1.2;
      ctx.strokeStyle = `rgba(${HOLO}, ${0.6 * fade})`;
      ctx.beginPath();
      for (const { start, end } of connections.contours) {
        const a = pts[start];
        const b = pts[end];
        if (!a || !b || !visible(a[1]) || !visible(b[1])) continue;
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();

      for (const [x, y] of pts) {
        if (!visible(y)) continue;
        // 走査線の近くほど明るい
        const near = Math.max(0, 1 - (scanY - y) / (span * 0.25));
        ctx.fillStyle = `rgba(${HOLO}, ${(0.35 + 0.65 * near) * fade})`;
        ctx.fillRect(x - 0.9, y - 0.9, 1.8, 1.8);
      }

      if (t < 0.7) {
        const g = ctx.createLinearGradient(0, scanY - 18, 0, scanY + 2);
        g.addColorStop(0, `rgba(${HOLO}, 0)`);
        g.addColorStop(1, `rgba(${HOLO}, 0.35)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, scanY - 18, size, 20);
        ctx.fillStyle = `rgba(${HOLO}, 0.8)`;
        ctx.fillRect(0, scanY, size, 1);
      }
    },
    () => ctx.clearRect(0, 0, size, size),
  );
}

/**
 * 切替演出：前の顔を粒子にしてばらけさせ、消す。
 * @param image 前の顔（size × size に描く）
 */
export function playDisperse(canvas: HTMLCanvasElement, image: CanvasImageSource, durationMs = 320): () => void {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return () => {};
  const size = canvas.width;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(image, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  ctx.clearRect(0, 0, size, size);

  const step = Math.max(3, Math.round(size / 128));
  const cx = size / 2;
  const cy = size / 2;
  type P = { x: number; y: number; vx: number; vy: number; color: string; delay: number };
  const particles: P[] = [];
  for (let y = 0; y < size; y += step) {
    for (let x = 0; x < size; x += step) {
      const i = (y * size + x) * 4;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      if (r + g + b < 30) continue; // 背景の黒は飛ばさない
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const speed = size * (0.25 + Math.random() * 0.45);
      particles.push({
        x,
        y,
        vx: (dx / dist) * speed + (Math.random() - 0.5) * size * 0.3,
        vy: (dy / dist) * speed + (Math.random() - 0.5) * size * 0.3 - size * 0.1,
        // 少しホログラムの色に寄せる
        color: `rgb(${(r * 0.6 + 127 * 0.4) | 0}, ${(g * 0.6 + 227 * 0.4) | 0}, ${(b * 0.6 + 255 * 0.4) | 0})`,
        delay: Math.random() * 0.25,
      });
    }
  }

  return animate(
    durationMs,
    (t) => {
      ctx.clearRect(0, 0, size, size);
      for (const p of particles) {
        const lt = Math.max(0, (t - p.delay) / (1 - p.delay));
        const ease = lt * lt;
        const alpha = 1 - lt;
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        const s = step * (1 - lt * 0.5);
        ctx.fillRect(p.x + p.vx * ease, p.y + p.vy * ease, s, s);
      }
      ctx.globalAlpha = 1;
    },
    () => ctx.clearRect(0, 0, size, size),
  );
}

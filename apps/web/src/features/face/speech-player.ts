"use client";

import { RENDERER_CONFIG } from "./renderer-config";
import type { FaceRenderer, WavAudio } from "./renderer";
import { type SyncStats, pickFrame, shouldStartPlayback } from "./speech-sync";

export type PlaySpeechOptions = {
  renderer: FaceRenderer;
  audio: WavAudio;
  /** フレームを描く Canvas（内部解像度はフレームに合わせて変える） */
  canvas: HTMLCanvasElement;
  signal?: AbortSignal;
  /** 音声が鳴り始めたとき（ここで静止画からしゃべる映像に切り替える） */
  onStart?: () => void;
};

export type PlaySpeechResult = SyncStats & {
  /** 音声を受け取ってから鳴り始めるまで（ms） */
  startLatencyMs: number;
  durationMs: number;
};

/**
 * 音声を鳴らしながら、レンダラーが返すフレームを再生位置に合わせて Canvas に描く。
 * 映像が少したまるまで音声を待たせ（startBufferMs）、その後は音声の時計を基準にする。
 * 映像が遅れたら直前のフレームのまま、進みすぎたフレームは捨てる。
 */
export async function playSpeech({ renderer, audio, canvas, signal, onStart }: PlaySpeechOptions): Promise<PlaySpeechResult> {
  const t0 = performance.now();
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) throw new Error("Canvas を使えません");
  const audioCtx = new AudioContext();
  const queue: VideoFrame[] = [];
  let current: VideoFrame | null = null;
  let ended = false;
  let producerError: unknown = null;
  const stats: SyncStats = { drawn: 0, dropped: 0, starved: 0 };
  const startBufferUs = RENDERER_CONFIG.startBufferMs * 1000;

  const cleanup = () => {
    for (const f of queue.splice(0)) f.close();
    current?.close();
    current = null;
    void audioCtx.close().catch(() => {});
  };

  try {
    // decodeAudioData は ArrayBuffer を使い切るので複製を渡す
    const buffer = await audioCtx.decodeAudioData(audio.data.slice(0));

    // フレームを受け取る（届いた順にためる）
    const producer = (async () => {
      for await (const frame of renderer.speak(audio, { signal, fps: RENDERER_CONFIG.fps })) {
        if (signal?.aborted) {
          frame.close();
          break;
        }
        queue.push(frame);
      }
    })()
      .catch((err: unknown) => {
        producerError = err;
      })
      .finally(() => {
        ended = true;
      });

    // 映像が少したまるまで待つ
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (signal?.aborted) return reject(new DOMException("中止しました", "AbortError"));
        if (producerError) return reject(producerError);
        const last = queue[queue.length - 1];
        const bufferedUntil = last ? last.timestamp + (last.duration ?? 0) : 0;
        if (shouldStartPlayback(bufferedUntil, ended, startBufferUs)) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    const audioEnded = new Promise<void>((r) => (source.onended = () => r()));
    signal?.addEventListener("abort", () => source.stop(), { once: true });
    if (audioCtx.state === "suspended") await audioCtx.resume();
    source.start();
    const startTime = audioCtx.currentTime;
    const startLatencyMs = performance.now() - t0;
    onStart?.();

    let lastDrawnTs = -1;
    let starvedOnCurrent = false;
    let done = false;
    const draw = () => {
      if (done) return;
      // スピーカーから実際に音が出るまでの遅れを差し引く
      const latency = audioCtx.outputLatency || audioCtx.baseLatency || 0;
      const clockUs = Math.max(0, (audioCtx.currentTime - startTime - latency) * 1e6);
      const { drawIndex, drop } = pickFrame(
        queue.map((f) => ({ timestampUs: f.timestamp, durationUs: f.duration ?? 0 })),
        clockUs,
      );
      if (drawIndex >= 0) {
        for (const f of queue.splice(0, drop)) {
          f.close();
          stats.dropped++;
        }
        const frame = queue.shift()!;
        current?.close();
        current = frame;
        starvedOnCurrent = false;
      } else if (current && !starvedOnCurrent && clockUs > current.timestamp + (current.duration ?? 0)) {
        // 今のフレームの表示時間を過ぎたのに次が届いていない（映像が止まって見える）
        starvedOnCurrent = true;
        stats.starved++;
      }
      if (current && current.timestamp !== lastDrawnTs) {
        if (canvas.width !== current.displayWidth || canvas.height !== current.displayHeight) {
          canvas.width = current.displayWidth;
          canvas.height = current.displayHeight;
        }
        ctx2d.drawImage(current, 0, 0, canvas.width, canvas.height);
        lastDrawnTs = current.timestamp;
        stats.drawn++;
      }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);

    await audioEnded;
    done = true;
    await producer;
    if (producerError && !signal?.aborted) throw producerError;
    return { ...stats, startLatencyMs, durationMs: performance.now() - t0 };
  } finally {
    cleanup();
  }
}

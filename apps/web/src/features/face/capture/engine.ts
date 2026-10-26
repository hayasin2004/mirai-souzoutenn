"use client";

import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import {
  type DetectedFace,
  type RawDetection,
  buildDetectedFace,
  canvas2d,
  createMetricsContext,
  measureFace,
  qualityOf,
  rawFromResult,
  renderFacePng,
  toBlob,
  toFaceRecord,
} from "../analyze";
import { type BustResult, renderBust } from "../bust-render";
import { computeBustCrop } from "../bust";
import type { CaptureStep, FaceConfig } from "../config";
import { computeCrop, toPixelLandmarks } from "../crop";
import { poseFromTransformMatrix } from "../pose";
import type { QualityReport } from "../quality";
import type { FaceRecord } from "../schema";
import { type TargetResult, evaluateTarget, frameQuality } from "./step-eval";
import { type HoldState, type TemporalReport, angularSpeeds, evaluateTemporal, frameScore, holdProgress, updateHold } from "./temporal";
import type { FrameSample } from "./types";

/** 画面に毎フレーム渡す状態 */
export type LiveState = {
  stepId: string;
  /** 段階の開始からの ms */
  t: number;
  sample: FrameSample;
  target: TargetResult;
  quality: QualityReport;
  angularSpeed: number | null;
  /** 0〜1。1 になったら記録 */
  holdProgress: number;
  /** timeoutSec を過ぎた */
  timedOut: boolean;
  /** 「今の最大値で記録」できる候補があるか */
  canAcceptBest: boolean;
  /** 実際の解析フレームレート */
  fps: number;
};

export type Keyframe = {
  t: number;
  width: number;
  height: number;
  face: DetectedFace;
  quality: QualityReport;
  originalJpeg: Blob;
  facePng: Blob;
  /** 肩から上の画像（正面の段階だけ） */
  bust: BustResult | null;
  record: FaceRecord;
};

export type StepOutcome =
  | {
      status: "recorded";
      step: CaptureStep;
      belowTarget: boolean;
      /** 段階のすべてのフレーム */
      samples: FrameSample[];
      hold: { fromT: number; toT: number };
      keyframe: Keyframe;
      temporal: TemporalReport;
      targetValue: number | null;
      video: Blob | null;
    }
  | { status: "skipped"; step: CaptureStep };

export class CaptureCancelledError extends Error {
  constructor() {
    super("撮影を中止しました");
  }
}

type Candidate = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; raw: RawDetection | null; sample: FrameSample | null; score: number };

function newCandidate(width: number, height: number): Candidate {
  const [canvas, ctx] = canvas2d(width, height);
  return { canvas, ctx, raw: null, sample: null, score: -Infinity };
}

/** 録画に使える形式（Chrome は VP9 を優先） */
export function pickVideoMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

/**
 * カメラ映像を毎フレーム解析し、段階（正面・角度・表情・自然な動き）を 1 つずつ記録する。
 * 1 回の runStep で 1 段階分の動画・全フレームの記録・一番よい 1 枚（キーフレーム）を返す。
 */
export class CaptureEngine {
  private readonly metricsCtx: CanvasRenderingContext2D;
  private readonly videoMimeType = pickVideoMimeType();
  private control: { acceptBest: () => void; skip: () => void; cancel: () => void } | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly stream: MediaStream,
    private readonly landmarker: FaceLandmarker,
    private readonly config: FaceConfig,
    private readonly overlay: HTMLCanvasElement | null,
  ) {
    this.metricsCtx = createMetricsContext(config);
  }

  get mimeType() {
    return this.videoMimeType;
  }

  /** タイムアウト後、今までで一番よいフレームで記録する */
  acceptBest() {
    this.control?.acceptBest();
  }

  /** 省略できる段階を飛ばす */
  skip() {
    this.control?.skip();
  }

  cancel() {
    this.control?.cancel();
  }

  runStep(step: CaptureStep, onLive: (live: LiveState) => void): Promise<StepOutcome> {
    if (this.control) throw new Error("前の段階がまだ動いています");
    const { video, config } = this;
    const cap = config.capture;
    const width = video.videoWidth;
    const height = video.videoHeight;

    return new Promise<StepOutcome>((resolve, reject) => {
      const samples: FrameSample[] = [];
      let holdSamples: FrameSample[] = [];
      let hold: HoldState = { since: null };
      const best = newCandidate(width, height);
      const fallback = newCandidate(width, height);
      let frameIndex = 0;
      let lastMetrics: { lum: number; sharp: number } | null = null;
      let lastVideoTime = -1;
      let start: number | null = null;
      let stopped = false;
      let finishing = false;
      let handle = 0;
      const useVfc = "requestVideoFrameCallback" in video;
      const fpsTimes: number[] = [];

      // 録画
      const chunks: Blob[] = [];
      let recorder: MediaRecorder | null = null;
      if (this.videoMimeType) {
        recorder = new MediaRecorder(this.stream, { mimeType: this.videoMimeType, videoBitsPerSecond: cap.videoBitsPerSecond });
        recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
        recorder.start(1000);
      }
      const stopRecording = () =>
        new Promise<Blob | null>((res) => {
          if (!recorder || recorder.state === "inactive") return res(chunks.length ? new Blob(chunks, { type: this.videoMimeType ?? "video/webm" }) : null);
          recorder.onstop = () => res(new Blob(chunks, { type: this.videoMimeType ?? "video/webm" }));
          recorder.stop();
        });

      const stopLoop = () => {
        stopped = true;
        if (useVfc) video.cancelVideoFrameCallback(handle);
        else cancelAnimationFrame(handle);
        this.control = null;
        this.clearOverlay();
      };

      const finish = async (mode: "hold" | "fallback" | "skip") => {
        if (finishing) return;
        finishing = true;
        stopLoop();
        const videoBlob = await stopRecording();
        if (mode === "skip") return resolve({ status: "skipped", step });
        const cand = mode === "hold" ? best : fallback;
        if (!cand.raw || !cand.sample) return reject(new Error("記録できるフレームがありませんでした"));
        try {
          const keyframe = await this.buildKeyframe(step, cand);
          // タイムアウトで記録したときは、キーフレームの前後 0.5 秒で動きを判定する
          const window =
            mode === "hold" ? holdSamples : samples.filter((s) => Math.abs(s.t - keyframe.t) <= 500);
          const targetValue = evaluateTarget(step, cand.sample, cap).value;
          resolve({
            status: "recorded",
            step,
            belowTarget: mode === "fallback",
            samples,
            hold: { fromT: window[0]?.t ?? keyframe.t, toT: window[window.length - 1]?.t ?? keyframe.t },
            keyframe,
            temporal: evaluateTemporal(step, window, cap),
            targetValue,
            video: videoBlob,
          });
        } catch (err) {
          reject(err);
        }
      };

      this.control = {
        acceptBest: () => fallback.raw && void finish("fallback"),
        skip: () => step.optional && void finish("skip"),
        cancel: () => {
          stopLoop();
          void stopRecording();
          reject(new CaptureCancelledError());
        },
      };

      const tick = () => {
        if (stopped) return;
        schedule();
        if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
        lastVideoTime = video.currentTime;

        const now = performance.now();
        start ??= now;
        const t = now - start;
        fpsTimes.push(now);
        while (fpsTimes.length > 0 && now - fpsTimes[0]! > 1000) fpsTimes.shift();

        const result = this.landmarker.detectForVideo(video, now);
        const faceCount = result.faceLandmarks.length;
        const raw = faceCount === 1 ? rawFromResult(result) : null;

        let sample: FrameSample;
        if (raw) {
          const px = toPixelLandmarks(raw.landmarks, width, height);
          const crop = computeCrop(px, width, height, config.crop);
          const measured = frameIndex % cap.metricsEveryNFrames === 0 || lastMetrics === null;
          if (measured) {
            const m = measureFace(video, crop, this.metricsCtx, config);
            lastMetrics = { lum: m.meanLuminance, sharp: m.laplacianVariance };
          }
          const r = crop.uprightFaceRect;
          sample = {
            t,
            faceCount,
            pose: poseFromTransformMatrix(raw.transformMatrix),
            blendshapes: raw.blendshapes,
            faceWidthPx: r.width,
            center: {
              x: px.reduce((s, p) => s + p.x, 0) / px.length,
              y: px.reduce((s, p) => s + p.y, 0) / px.length,
            },
            meanLuminance: lastMetrics?.lum ?? null,
            laplacianVariance: lastMetrics?.sharp ?? null,
            metricsMeasured: measured,
            cropOutsideRatio: crop.outsideRatio,
            ...(step.kind === "front"
              ? { bustOutsideRatio: computeBustCrop(px, width, height, config.bust).outsideRatio }
              : {}),
          };
        } else {
          sample = {
            t,
            faceCount,
            pose: null,
            blendshapes: null,
            faceWidthPx: null,
            center: null,
            meanLuminance: lastMetrics?.lum ?? null,
            laplacianVariance: lastMetrics?.sharp ?? null,
            metricsMeasured: false,
            cropOutsideRatio: null,
          };
        }
        frameIndex++;
        samples.push(sample);

        const speed = angularSpeeds(samples.slice(-12)).at(-1) ?? null;
        const target = evaluateTarget(step, sample, cap);
        const quality = frameQuality(step, sample, config);
        const calm = speed === null || speed <= cap.motion.angularSpeedDegPerSec.pass;
        const ok =
          step.kind === "free"
            ? true
            : faceCount === 1 && target.met && quality.status !== "fail" && calm;

        // 記録の候補（一番よいフレーム）を残す
        const score = raw ? frameScore(step, sample, speed, cap) : -Infinity;
        if (raw && quality.status !== "fail" && score > fallback.score) this.keep(fallback, raw, sample, score);

        const wasHolding = hold.since !== null;
        hold = updateHold(hold, ok, t);
        if (!ok) {
          holdSamples = [];
          best.score = -Infinity;
          best.raw = null;
          best.sample = null;
        } else {
          if (!wasHolding) holdSamples = [];
          holdSamples.push(sample);
          if (raw && score > best.score) this.keep(best, raw, sample, score);
        }

        const progress = holdProgress(hold, t, step.holdSec);
        const timedOut = step.timeoutSec !== undefined && t > step.timeoutSec * 1000;
        this.drawOverlay(raw, ok);
        onLive({
          stepId: step.id,
          t,
          sample,
          target,
          quality,
          angularSpeed: speed,
          holdProgress: progress,
          timedOut,
          canAcceptBest: timedOut && fallback.raw !== null,
          fps: fpsTimes.length,
        });

        if (progress >= 1 && best.raw) void finish("hold");
      };

      const schedule = () => {
        if (useVfc) handle = video.requestVideoFrameCallback(tick);
        else handle = requestAnimationFrame(tick);
      };
      schedule();
    });
  }

  /** 候補のフレームを元の解像度のまま残す */
  private keep(c: Candidate, raw: RawDetection, sample: FrameSample, score: number) {
    c.ctx.drawImage(this.video, 0, 0, c.canvas.width, c.canvas.height);
    c.raw = raw;
    c.sample = sample;
    c.score = score;
  }

  private async buildKeyframe(step: CaptureStep, cand: Candidate): Promise<Keyframe> {
    const { canvas } = cand;
    const raw = cand.raw!;
    const sample = cand.sample!;
    const face = buildDetectedFace(canvas, canvas.width, canvas.height, raw, this.config, this.metricsCtx);
    // 正面は顔を動かす処理の元画像になるので、肩から上も作る
    const [originalJpeg, facePng, bust] = await Promise.all([
      toBlob(canvas, "image/jpeg", 0.95),
      renderFacePng(canvas, face.crop, this.config),
      step.kind === "front" ? renderBust(canvas, canvas.width, canvas.height, raw.landmarks, this.config) : null,
    ]);
    const quality = qualityOf(1, face, this.config, { skip: step.skipChecks ?? [] }, bust);
    const record = toFaceRecord(
      {
        width: canvas.width,
        height: canvas.height,
        mimeType: "image/jpeg",
        faceCount: 1,
        face,
        quality,
        capturedAt: { value: new Date().toISOString(), source: "camera" },
        bust,
      },
      this.config,
      { stepId: step.id, kind: step.kind, frameTimeMs: sample.t },
    );
    if (!record) throw new Error("記録を作れませんでした");
    return { t: sample.t, width: canvas.width, height: canvas.height, face, quality, originalJpeg, facePng, bust, record };
  }

  private drawOverlay(raw: RawDetection | null, ok: boolean) {
    const c = this.overlay;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!raw) return;
    ctx.fillStyle = ok ? "rgba(127, 227, 255, 0.75)" : "rgba(242, 194, 92, 0.6)";
    for (const p of raw.landmarks) ctx.fillRect(p.x * c.width - 0.8, p.y * c.height - 0.8, 1.6, 1.6);
  }

  private clearOverlay() {
    const c = this.overlay;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  }
}

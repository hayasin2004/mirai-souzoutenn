"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { type CaptureStep, FACE_CONFIG } from "../config";
import { CaptureCancelledError, CaptureEngine, type LiveState, type StepOutcome } from "../capture/engine";
import { combineLevels, evaluateRecordedStep, missingRequiredSteps } from "../capture/session";
import { type CameraInfo, buildCaptureForm, toRecordedStepData } from "../capture/upload";
import { getFaceLandmarker } from "../landmarker";
import { LiveGuide } from "./LiveGuide";
import { CaptureReview, type ReviewItem } from "./CaptureReview";

const config = FACE_CONFIG;
const STEPS = config.capture.steps;

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running"; stepIndex: number; single: boolean }
  | { kind: "between"; message: string }
  | { kind: "review" }
  | { kind: "error"; message: string };

type Item = { outcome: StepOutcome; faceUrl: string | null; videoUrl: string | null; bustUrl: string | null };

function revokeItem(it: Item | undefined) {
  if (!it) return;
  for (const url of [it.faceUrl, it.videoUrl, it.bustUrl]) if (url) URL.revokeObjectURL(url);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cameraError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "カメラの使用が許可されていません。ブラウザのアドレスバーの設定からカメラを許可してください。";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "カメラが見つかりません。接続を確認してください。";
  if (name === "NotReadableError") return "カメラをほかのアプリが使っています。ほかのアプリを閉じてください。";
  return "カメラを起動できませんでした。";
}

export function CaptureStudio({ personId }: { personId: string }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const engineRef = useRef<CaptureEngine | null>(null);

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [live, setLive] = useState<LiveState | null>(null);
  const [items, setItems] = useState<Map<string, Item>>(new Map());
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [camera, setCamera] = useState<CameraInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const stopCamera = useCallback(() => {
    engineRef.current?.cancel();
    engineRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // 画面を離れるときにカメラを止め、プレビュー用の URL を片付ける
  useEffect(
    () => () => {
      stopCamera();
      for (const it of itemsRef.current.values()) revokeItem(it);
    },
    [stopCamera],
  );

  const ensureCamera = useCallback(async (): Promise<CaptureEngine> => {
    if (engineRef.current && streamRef.current?.active) return engineRef.current;
    const video = videoRef.current;
    if (!video) throw new Error("video がありません");
    const c = config.capture.camera;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
        width: { ideal: c.width },
        height: { ideal: c.height },
        frameRate: { ideal: c.frameRate },
      },
    });
    streamRef.current = stream;
    video.srcObject = stream;
    await video.play();
    await new Promise<void>((r) => (video.readyState >= 2 ? r() : video.addEventListener("loadeddata", () => r(), { once: true })));

    const overlay = overlayRef.current;
    if (overlay) {
      overlay.width = Math.round(video.videoWidth / 2);
      overlay.height = Math.round(video.videoHeight / 2);
    }
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput"));
    if (settings?.deviceId) setDeviceId(settings.deviceId);

    const landmarker = await getFaceLandmarker("VIDEO");
    const engine = new CaptureEngine(video, stream, landmarker, config, overlay);
    engineRef.current = engine;
    setCamera({
      label: track?.label ?? "",
      width: video.videoWidth,
      height: video.videoHeight,
      frameRate: settings?.frameRate ?? null,
      videoMimeType: engine.mimeType,
    });
    return engine;
  }, [deviceId]);

  const store = useCallback((outcome: StepOutcome) => {
    setItems((prev) => {
      const next = new Map(prev);
      revokeItem(next.get(outcome.step.id));
      const rec = outcome.status === "recorded" ? outcome : null;
      next.set(outcome.step.id, {
        outcome,
        faceUrl: rec ? URL.createObjectURL(rec.keyframe.facePng) : null,
        videoUrl: rec?.video ? URL.createObjectURL(rec.video) : null,
        bustUrl: rec?.keyframe.bust ? URL.createObjectURL(rec.keyframe.bust.cutoutPng) : null,
      });
      return next;
    });
  }, []);

  /** fromIndex の段階から撮る。single なら 1 段階だけ（撮り直し） */
  const run = useCallback(
    async (fromIndex: number, single: boolean) => {
      setMessage(null);
      setPhase({ kind: "starting" });
      let engine: CaptureEngine;
      try {
        engine = await ensureCamera();
      } catch (err) {
        console.error(err);
        stopCamera();
        setPhase({ kind: "error", message: cameraError(err) });
        return;
      }
      for (let i = fromIndex; i < STEPS.length; i++) {
        const step = STEPS[i]!;
        setLive(null);
        setPhase({ kind: "running", stepIndex: i, single });
        try {
          store(await engine.runStep(step, setLive));
        } catch (err) {
          if (err instanceof CaptureCancelledError) return;
          console.error(err);
          setPhase({ kind: "error", message: err instanceof Error ? err.message : "記録に失敗しました" });
          return;
        }
        if (single) break;
        const next = STEPS[i + 1];
        if (next) {
          setPhase({ kind: "between", message: `記録しました。次は「${next.label}」` });
          await sleep(900);
        }
      }
      setLive(null);
      setPhase({ kind: "review" });
    },
    [ensureCamera, stopCamera, store],
  );

  async function save() {
    if (!camera) return;
    setSaving(true);
    setMessage(null);
    try {
      const outcomes = new Map([...items].map(([k, v]) => [k, v.outcome]));
      const res = await fetch(`/api/persons/${personId}/captures`, { method: "POST", body: buildCaptureForm(outcomes, camera, config) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMessage({ ok: false, text: body.error ?? `保存に失敗しました（${res.status}）` });
        return;
      }
      setMessage({ ok: true, text: "保存しました。正面の顔が使用中になりました。" });
      stopCamera();
      setItems(new Map());
      setPhase({ kind: "idle" });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: "保存に失敗しました。サーバーが動いているか確認してください" });
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    engineRef.current?.cancel();
    setLive(null);
    setPhase(items.size > 0 ? { kind: "review" } : { kind: "idle" });
    if (items.size === 0) stopCamera();
  }

  const running = phase.kind === "running" ? STEPS[phase.stepIndex]! : null;
  const showCamera = phase.kind === "starting" || phase.kind === "running" || phase.kind === "between";

  // 確認画面用の判定（サーバーと同じ関数）
  const review: ReviewItem[] = STEPS.map((step) => {
    const it = items.get(step.id);
    if (!it) return { step, state: "pending" as const };
    if (it.outcome.status === "skipped") return { step, state: "skipped" as const };
    const ev = evaluateRecordedStep(toRecordedStepData(it.outcome), config);
    return {
      step,
      state: "recorded" as const,
      outcome: it.outcome,
      evaluation: ev,
      faceUrl: it.faceUrl!,
      videoUrl: it.videoUrl,
      bustUrl: it.bustUrl,
    };
  });
  const recordedIds = new Set(review.filter((r) => r.state === "recorded").map((r) => r.step.id));
  const missing = missingRequiredSteps(STEPS, recordedIds);
  const overall = combineLevels(review.flatMap((r) => (r.state === "recorded" ? [r.evaluation.level] : [])));

  return (
    <div className="space-y-5">
      <div className={showCamera ? "grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : "hidden"}>
        <div className="relative overflow-hidden rounded-sm border border-line bg-black">
          {/* 鏡のように左右反転して表示する（記録する映像は反転しない） */}
          <video ref={videoRef} muted playsInline className="block w-full -scale-x-100" />
          <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 size-full -scale-x-100" />
          <FaceGuideFrame active={live?.holdProgress ? live.holdProgress > 0 : false} />
          {phase.kind === "between" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60">
              <p className="text-lg text-holo">{phase.message}</p>
            </div>
          )}
          {phase.kind === "starting" && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="label">CAMERA STARTING…</p>
            </div>
          )}
        </div>
        <div className="space-y-4">
          {running && (
            <LiveGuide
              step={running}
              index={STEPS.indexOf(running)}
              total={STEPS.length}
              live={live}
              config={config}
              onAcceptBest={() => engineRef.current?.acceptBest()}
              onSkip={() => engineRef.current?.skip()}
              onCancel={cancel}
            />
          )}
        </div>
      </div>

      {phase.kind === "idle" && (
        <div className="panel space-y-4 p-5">
          <p>
            Web カメラの映像を解析しながら、正面・4 方向の角度・4 つの表情・自然な動きを順に記録します（約 1 分）。
            各段階の映像と、一番よい瞬間の顔を保存します。
          </p>
          <ol className="grid gap-1 text-sm text-ink-dim sm:grid-cols-2">
            {STEPS.map((s, i) => (
              <li key={s.id} className="font-mono">
                {String(i + 1).padStart(2, "0")} {s.label}
                {s.optional && "（省略可）"}
              </li>
            ))}
          </ol>
          <CameraSelect devices={devices} deviceId={deviceId} onChange={setDeviceId} />
          <button type="button" className="btn btn-primary" onClick={() => void run(0, false)}>
            カメラを起動して撮影をはじめる
          </button>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="panel space-y-3 border-ng/40 p-5">
          <p className="text-ng">{phase.message}</p>
          <button type="button" className="btn" onClick={() => setPhase(items.size ? { kind: "review" } : { kind: "idle" })}>
            戻る
          </button>
        </div>
      )}

      {message && <p className={`text-sm ${message.ok ? "text-ok" : "text-ng"}`}>{message.text}</p>}

      {phase.kind === "review" && (
        <CaptureReview
          items={review}
          overall={overall}
          missing={missing}
          saving={saving}
          onRetake={(step: CaptureStep) => void run(STEPS.indexOf(step), true)}
          onContinue={(step: CaptureStep) => void run(STEPS.indexOf(step), false)}
          onSave={() => void save()}
          onDiscard={() => {
            stopCamera();
            for (const it of items.values()) revokeItem(it);
            setItems(new Map());
            setPhase({ kind: "idle" });
          }}
        />
      )}
    </div>
  );
}

function CameraSelect({
  devices,
  deviceId,
  onChange,
}: {
  devices: MediaDeviceInfo[];
  deviceId: string;
  onChange: (id: string) => void;
}) {
  if (devices.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="label">CAMERA</span>
      <select className="input" value={deviceId} onChange={(e) => onChange(e.target.value)}>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `カメラ ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 顔を合わせる位置の目安（楕円の枠） */
function FaceGuideFrame({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid meet" className="pointer-events-none absolute inset-0 size-full" aria-hidden>
      <ellipse
        cx="80"
        cy="44"
        rx="19"
        ry="26"
        fill="none"
        stroke={active ? "rgb(127 227 255 / 0.8)" : "rgb(127 227 255 / 0.3)"}
        strokeWidth="0.4"
        strokeDasharray="2 1.5"
      />
    </svg>
  );
}

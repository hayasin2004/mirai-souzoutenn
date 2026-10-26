"use client";

import { type Ref, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from "react";
import { FACE_CONFIG } from "../config";
import { type FaceConnections, loadFaceConnections, playDisperse, playScan } from "../effects";
import type { AvatarAssetDescriptor } from "../renderer";

type Point = readonly [number, number, number];

type LoadedFace = {
  asset: AvatarAssetDescriptor;
  name: string;
  /** bust = 肩から上の切り抜き（顔を動かす元画像と同じ）, face = 512 の顔の切り出し（古いデータ） */
  mode: "bust" | "face";
  imageUrl: string;
  /** 表示する画像に対する 0〜1 */
  landmarks: Point[];
};

type ActiveResponse = {
  person: { id: string; name: string };
  active: Omit<AvatarAssetDescriptor, "personId"> | null;
};

/** 外から操作するための口（話している映像への切り替え） */
export type FaceDisplayHandle = {
  /** しゃべる映像を描く Canvas */
  speechCanvas: HTMLCanvasElement | null;
  /** 表示中の顔 */
  asset: AvatarAssetDescriptor | null;
  /** true の間は静止画の代わりにしゃべる映像を見せる */
  setSpeaking: (speaking: boolean) => void;
};

/** 演出用 Canvas の内部解像度 */
const FX_SIZE = 512;
/** 切替：前の顔が粒子になって消える時間と、新しい顔が現れる時間（合計 0.5 秒以内） */
const DISPERSE_MS = 320;
const APPEAR_DELAY_MS = 180;
const APPEAR_MS = 280;
const SCAN_MS = 600;

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

async function loadFace(personId: string, signal: AbortSignal): Promise<LoadedFace | null> {
  const res = await fetch(`/api/persons/${encodeURIComponent(personId)}/face`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`顔データを取得できません（${res.status}）`);
  const body = (await res.json()) as ActiveResponse;
  if (!body.active) return null;
  const asset: AvatarAssetDescriptor = { personId, ...body.active };
  const mode = asset.bustCutoutUrl ? "bust" : "face";
  const imageUrl = asset.bustCutoutUrl ?? asset.faceUrl;
  const [record] = await Promise.all([
    fetch(asset.landmarksUrl, { signal, cache: "no-store" }).then(
      (r) => r.json() as Promise<{ crop: { landmarks: Point[] }; bust?: { landmarks: Point[] } }>,
    ),
    // 表示前に画像を読み終えておく（切替の途中で空白にならないように）
    new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("顔画像を読み込めません"));
      img.src = imageUrl;
    }),
  ]);
  const landmarks = mode === "bust" && record.bust ? record.bust.landmarks : record.crop.landmarks;
  return { asset, name: body.person.name, mode, imageUrl, landmarks };
}

/** 顔の輪郭（FACE_OVAL）を SVG のパスにする */
function ovalPath(landmarks: readonly Point[], connections: FaceConnections | null): string {
  if (!connections) return "";
  return connections.oval
    .map(({ start, end }) => {
      const a = landmarks[start];
      const b = landmarks[end];
      return a && b ? `M${a[0] * 100} ${a[1] * 100}L${b[0] * 100} ${b[1] * 100}` : "";
    })
    .join("");
}

export type FaceDisplayProps = {
  personId: string;
  className?: string;
  /** 読み込みが終わり、表示する人物が決まったとき */
  onShown?: (face: { personId: string; name: string; asset: AvatarAssetDescriptor } | null) => void;
  ref?: Ref<FaceDisplayHandle>;
};

/**
 * 展示画面で、使用中の顔をホログラム風に表示する。
 * - 輪郭のうっすらした発光・細い走査線・わずかなちらつき
 * - 表示するとき、ランドマークの点と線が 0.6 秒で顔の上を走って消える
 * - 人物を切り替えると、前の顔が粒子になってばらけ、次の顔に変わる
 * - 肩から上の画像があれば、ゆっくり呼吸しているように少しだけ拡大縮小する
 * - しゃべるときは ref の setSpeaking(true) で、speechCanvas に描いた映像に切り替える
 * - prefers-reduced-motion のときは動く演出をすべて止める
 */
export function FaceDisplay({ personId, className = "", onShown, ref }: FaceDisplayProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [face, setFace] = useState<LoadedFace | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [appearing, setAppearing] = useState(false);
  const [connections, setConnections] = useState<FaceConnections | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const speechRef = useRef<HTMLCanvasElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      get speechCanvas() {
        return speechRef.current;
      },
      get asset() {
        return faceRef.current?.asset ?? null;
      },
      setSpeaking,
    }),
    [],
  );

  const imgRef = useRef<HTMLImageElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  const faceRef = useRef<LoadedFace | null>(null);
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;

  useEffect(() => {
    let alive = true;
    loadFaceConnections().then((c) => alive && setConnections(c), console.error);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const stops: (() => void)[] = [];
    const timers: number[] = [];

    (async () => {
      let next: LoadedFace | null;
      try {
        next = await loadFace(personId, ac.signal);
      } catch (err) {
        if (ac.signal.aborted) return;
        console.error(err);
        setStatus("error");
        return;
      }
      if (ac.signal.aborted) return;

      const prev = faceRef.current;
      const canvas = fxRef.current;
      const img = imgRef.current;
      const animateMotion = !reducedMotion && canvas;

      // 前の顔を粒子にしてばらけさせる
      if (animateMotion && prev && img?.complete && img.naturalWidth > 0) {
        stops.push(playDisperse(canvas, img, DISPERSE_MS));
      }

      const show = () => {
        faceRef.current = next;
        setFace(next);
        setStatus(next ? "ready" : "empty");
        onShownRef.current?.(next ? { personId, name: next.name, asset: next.asset } : null);
        if (!next || !animateMotion) return;
        setAppearing(true);
        timers.push(window.setTimeout(() => setAppearing(false), APPEAR_MS));
        loadFaceConnections()
          .then((c) => {
            if (!ac.signal.aborted) stops.push(playScan(canvas, next.landmarks, c, SCAN_MS));
          })
          .catch(console.error);
      };

      if (animateMotion && prev) {
        setAppearing(true);
        timers.push(window.setTimeout(show, APPEAR_DELAY_MS));
      } else {
        show();
      }
    })();

    return () => {
      ac.abort();
      stops.forEach((stop) => stop());
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [personId, reducedMotion]);

  const animated = !reducedMotion;
  const bust = FACE_CONFIG.bust;
  const aspect = face?.mode === "bust" ? `${bust.outputWidth} / ${bust.outputHeight}` : "1 / 1";

  return (
    <div
      className={`holo-frame relative select-none ${animated ? "holo-animated" : ""} ${className}`}
      style={{ aspectRatio: aspect }}
    >
      {face && (
        <div
          className={`absolute inset-0 transition-opacity ease-out ${animated && face.mode === "bust" ? "holo-breathe" : ""}`}
          style={{
            opacity: appearing ? 0 : 1,
            transitionDuration: animated ? `${APPEAR_MS}ms` : "0ms",
          }}
        >
          <img
            ref={imgRef}
            src={face.imageUrl}
            alt={`${face.name} の顔`}
            draggable={false}
            className={`${face.mode === "bust" ? "holo-bust" : "holo-face"} absolute inset-0 size-full`}
            style={{ opacity: speaking ? 0 : 1 }}
          />
          <canvas
            ref={speechRef}
            className="holo-bust pointer-events-none absolute inset-0 size-full"
            style={{ opacity: speaking ? 1 : 0 }}
            aria-hidden
          />
          <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 size-full" aria-hidden>
            <defs>
              <filter id="holo-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="1.4" />
              </filter>
            </defs>
            <path d={ovalPath(face.landmarks, connections)} className="holo-outline-glow" filter="url(#holo-glow)" />
            <path d={ovalPath(face.landmarks, connections)} className="holo-outline" />
          </svg>
        </div>
      )}

      <div className="holo-scanlines pointer-events-none absolute inset-0" aria-hidden />
      <canvas ref={fxRef} width={FX_SIZE} height={FX_SIZE} className="pointer-events-none absolute inset-0 size-full" aria-hidden />

      {status !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="label">
            {status === "loading" && "LOADING…"}
            {status === "empty" && "NO FACE DATA"}
            {status === "error" && "SIGNAL LOST"}
          </p>
        </div>
      )}
    </div>
  );
}

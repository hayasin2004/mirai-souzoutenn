/**
 * 顔を動かす処理の差し込み口。
 *
 * - StaticFaceRenderer: 静止画を流すだけ（PC-A が無いとき・落ちたときの代わり）
 * - RemoteFaceRenderer: PC-A の Python サービス（services/face-renderer。Ditto + LivePortrait）につなぐ
 *
 * 流れ:
 *   1. prepare(asset)   使用中の顔（肩から上の画像）を読み込む。リモート実装ではサービスへ送り、
 *                       特徴量を作らせておく。
 *   2. speak(audio)     声のサービス（PC-A）が返した WAV を渡すと、口の動きに合わせた映像を
 *                       VideoFrame として順に返す。各フレームの timestamp（マイクロ秒）は
 *                       音声の先頭を 0 とした再生位置。呼び出し側は音声の再生と timestamp を
 *                       合わせて描画し（speech-player.ts）、使い終わったフレームは必ず close() する。
 *   3. dispose()        読み込んだ資源を解放する。
 */
import { FRAME_STREAM_MIME, FrameStreamParser, prepareResponseSchema } from "./renderer-protocol";
import { parseWavInfo } from "./wav";

/** 展示で使う顔 1 枚分の情報 */
export type AvatarAssetDescriptor = {
  personId: string;
  assetId: string;
  /** 512×512 の face.png の URL */
  faceUrl: string;
  /** landmarks.json の URL */
  landmarksUrl: string;
  /** 肩から上（背景つき） / 背景を透明にしたもの。古いデータには無い */
  bustUrl: string | null;
  bustCutoutUrl: string | null;
};

/** 声のサービスが返す音声。WAV（RIFF/PCM）をそのまま渡す */
export type WavAudio = {
  mimeType: "audio/wav";
  data: ArrayBuffer;
};

export type SpeakOptions = {
  /** 途中で止める（来場者が話し始めた等） */
  signal?: AbortSignal;
  /** 欲しいフレームレート。実装は近い値で返してよい */
  fps?: number;
};

export interface FaceRenderer {
  /** 実装の名前（ログ・デバッグ用）。例: "static", "remote" */
  readonly kind: string;
  prepare(asset: AvatarAssetDescriptor, options?: { signal?: AbortSignal }): Promise<void>;
  speak(audio: WavAudio, options?: SpeakOptions): AsyncIterable<VideoFrame>;
  dispose(): void;
}

export class RendererNotPreparedError extends Error {
  constructor() {
    super("prepare() を先に呼んでください");
  }
}

/**
 * 顔を動かす元画像を作る。肩から上の切り抜きがあれば黒背景に重ね（ホログラム表示に合わせる）、
 * 無ければ 512 の顔画像を使う。
 */
export async function loadSourceImage(asset: AvatarAssetDescriptor, signal?: AbortSignal): Promise<ImageBitmap> {
  const url = asset.bustCutoutUrl ?? asset.faceUrl;
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`顔画像を読み込めません（${res.status}）`);
  const img = await createImageBitmap(await res.blob());
  if (!asset.bustCutoutUrl) return img;
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas を使えません");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, img.width, img.height);
  ctx.drawImage(img, 0, 0);
  img.close();
  return canvas.transferToImageBitmap();
}

/**
 * 静止画を表示するだけの実装。音声の長さぶん、同じ顔のフレームを fps 間隔の timestamp で返す。
 * 描画のタイミングは呼び出し側が timestamp と音声の再生位置で合わせる前提で、ここでは待たない。
 */
export class StaticFaceRenderer implements FaceRenderer {
  readonly kind = "static";
  private bitmap: ImageBitmap | null = null;

  async prepare(asset: AvatarAssetDescriptor, options?: { signal?: AbortSignal }): Promise<void> {
    const bitmap = await loadSourceImage(asset, options?.signal);
    this.bitmap?.close();
    this.bitmap = bitmap;
  }

  async *speak(audio: WavAudio, options?: SpeakOptions): AsyncIterable<VideoFrame> {
    const bitmap = this.bitmap;
    if (!bitmap) throw new RendererNotPreparedError();
    const { durationSec } = parseWavInfo(audio.data);
    const fps = options?.fps ?? 25;
    const frameUs = 1_000_000 / fps;
    const total = Math.max(1, Math.ceil(durationSec * fps));
    for (let i = 0; i < total; i++) {
      if (options?.signal?.aborted) return;
      yield new VideoFrame(bitmap, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
    }
  }

  dispose(): void {
    this.bitmap?.close();
    this.bitmap = null;
  }
}

export class RemoteRendererError extends Error {}

/**
 * PC-A のサービスにつなぐ実装（形式は renderer-protocol.ts / services/face-renderer/PROTOCOL.md）。
 * フレームは届いた順に VideoFrame にして返す。音声との同期は呼び出し側で行う。
 */
export class RemoteFaceRenderer implements FaceRenderer {
  readonly kind = "remote";
  private sourceId: string | null = null;

  constructor(private readonly baseUrl: string) {}

  async prepare(asset: AvatarAssetDescriptor, options?: { signal?: AbortSignal }): Promise<void> {
    const bitmap = await loadSourceImage(asset, options?.signal);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    const source = await canvas.convertToBlob({ type: "image/png" });

    const form = new FormData();
    form.append("source", source, "source.png");
    form.append("assetId", asset.assetId);
    const landmarks = await fetch(asset.landmarksUrl, { signal: options?.signal, cache: "no-store" });
    if (landmarks.ok) form.append("landmarks", await landmarks.text());

    const res = await fetch(`${this.baseUrl}/prepare`, { method: "POST", body: form, signal: options?.signal });
    if (!res.ok) throw new RemoteRendererError(`顔を動かすサービスの準備に失敗しました（${res.status}）`);
    this.sourceId = prepareResponseSchema.parse(await res.json()).sourceId;
  }

  async *speak(audio: WavAudio, options?: SpeakOptions): AsyncIterable<VideoFrame> {
    if (!this.sourceId) throw new RendererNotPreparedError();
    const params = new URLSearchParams({ sourceId: this.sourceId, fps: String(options?.fps ?? 25) });
    const res = await fetch(`${this.baseUrl}/speak?${params}`, {
      method: "POST",
      headers: { "Content-Type": audio.mimeType, Accept: FRAME_STREAM_MIME },
      body: audio.data,
      signal: options?.signal,
    });
    if (!res.ok || !res.body) throw new RemoteRendererError(`顔を動かすサービスがエラーを返しました（${res.status}）`);

    const reader = res.body.getReader();
    const parser = new FrameStreamParser();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const msg of parser.push(value)) {
          const h = msg.header;
          if (h.type === "error") throw new RemoteRendererError(`顔を動かすサービスのエラー: ${h.message}`);
          if (h.type === "end") return;
          const bitmap = await createImageBitmap(new Blob([msg.body], { type: h.mime }));
          try {
            yield new VideoFrame(bitmap, { timestamp: h.timestampUs, duration: h.durationUs });
          } finally {
            bitmap.close();
          }
        }
      }
      if (parser.pendingBytes > 0) throw new RemoteRendererError("映像の途中で通信が切れました");
    } finally {
      reader.releaseLock();
      void res.body.cancel().catch(() => {});
    }
  }

  dispose(): void {
    this.sourceId = null;
  }
}

import { healthSchema } from "./renderer-protocol";
import { type FaceRenderer, RemoteFaceRenderer, StaticFaceRenderer } from "./renderer";

/**
 * 顔を動かす処理の設定。
 * NEXT_PUBLIC_FACE_RENDERER_URL に PC-A のサービスの URL（例 http://192.168.0.10:8000）を入れると使う。
 * "mock" にすると開発用の試験サーバー（/api/dev/renderer。静止画を流すだけ）を使う。
 * 空なら静止画のみ。値はビルド時に埋め込まれるので、変えたら作り直す（pnpm build / dev の再起動）。
 */
export const RENDERER_CONFIG = {
  remoteUrl: process.env.NEXT_PUBLIC_FACE_RENDERER_URL ?? "",
  /** 欲しいフレームレート */
  fps: 25,
  /** 音声を鳴らし始める前にためておく映像の長さ（ms）。途中で映像が止まらないように */
  startBufferMs: 240,
  /** PC-A の死活確認の待ち時間（ms） */
  healthTimeoutMs: 1500,
};

export const MOCK_RENDERER_PATH = "/api/dev/renderer";

export type RendererKind = "static" | "mock" | "remote";

export function rendererBaseUrl(kind: RendererKind): string | null {
  if (kind === "mock") return MOCK_RENDERER_PATH;
  if (kind === "remote") {
    const url = RENDERER_CONFIG.remoteUrl;
    if (!url) return null;
    return url === "mock" ? MOCK_RENDERER_PATH : url.replace(/\/$/, "");
  }
  return null;
}

/** サービスが動いているか。動いていなければ理由を返す */
export async function checkRendererHealth(baseUrl: string): Promise<{ ok: true; backend: string } | { ok: false; reason: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RENDERER_CONFIG.healthTimeoutMs);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: ac.signal, cache: "no-store" });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const h = healthSchema.safeParse(await res.json());
    return h.success ? { ok: true, backend: h.data.backend } : { ok: false, reason: "応答の形式が違います" };
  } catch (err) {
    return { ok: false, reason: ac.signal.aborted ? "応答がありません" : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 使うレンダラーを決める。リモートが指定されていても動いていなければ静止画にする（展示を止めない）。
 */
export async function createFaceRenderer(kind: RendererKind): Promise<{ renderer: FaceRenderer; note: string | null }> {
  const base = rendererBaseUrl(kind);
  if (!base) {
    return {
      renderer: new StaticFaceRenderer(),
      note: kind === "remote" ? "NEXT_PUBLIC_FACE_RENDERER_URL が設定されていないので静止画で表示します" : null,
    };
  }
  const health = await checkRendererHealth(base);
  if (!health.ok) {
    return { renderer: new StaticFaceRenderer(), note: `顔を動かすサービスにつながらないので静止画で表示します（${health.reason}）` };
  }
  return { renderer: new RemoteFaceRenderer(base), note: null };
}

/**
 * 開発用の試験サーバー（PC-A の顔を動かすサービスの代わり）。形式は renderer-protocol.ts と同じ。
 * 受け取った元画像をそのまま、音声の長さぶん流すだけ（口は動かない）。
 * 通信・同期・切り替えの確認用。本番（pnpm start）では FACE_RENDERER_MOCK=1 のときだけ動く。
 */
import { NextResponse } from "next/server";
import { pngSize } from "@/features/face/image-format";
import { FRAME_STREAM_MIME, encodeFrameMessage } from "@/features/face/renderer-protocol";
import { WavFormatError, parseWavInfo } from "@/features/face/wav";

type Ctx = { params: Promise<{ action: string }> };

type Source = { png: Uint8Array; width: number; height: number };
const globalStore = globalThis as unknown as { __mockRendererSources?: Map<string, Source> };
const sources = (globalStore.__mockRendererSources ??= new Map());

/** 生成にかかる時間のまね：最初のフレームまでの遅れと、1 フレームあたりの時間（実時間に対する割合） */
const FIRST_FRAME_DELAY_MS = 350;
const SPEED_RATIO = 0.6;

const enabled = () => process.env.NODE_ENV !== "production" || process.env.FACE_RENDERER_MOCK === "1";
const notFound = () => NextResponse.json({ error: "見つかりません" }, { status: 404 });

export async function GET(_req: Request, { params }: Ctx) {
  if (!enabled()) return notFound();
  const { action } = await params;
  if (action !== "health") return notFound();
  return NextResponse.json({ status: "ok", backend: "mock-static", version: "0" });
}

export async function POST(req: Request, { params }: Ctx) {
  if (!enabled()) return notFound();
  const { action } = await params;

  if (action === "prepare") {
    const form = await req.formData();
    const source = form.get("source");
    if (!(source instanceof File)) return NextResponse.json({ error: "source がありません" }, { status: 400 });
    const png = new Uint8Array(await source.arrayBuffer());
    const size = pngSize(png);
    if (!size) return NextResponse.json({ error: "source は PNG にしてください" }, { status: 400 });
    const sourceId = crypto.randomUUID();
    sources.set(sourceId, { png, ...size });
    // 古いものから捨てる（開発用なのでメモリに置くだけ）
    while (sources.size > 8) sources.delete(sources.keys().next().value!);
    return NextResponse.json({ sourceId, ...size });
  }

  if (action === "speak") {
    const url = new URL(req.url);
    const src = sources.get(url.searchParams.get("sourceId") ?? "");
    if (!src) return NextResponse.json({ error: "先に prepare してください" }, { status: 404 });
    const fps = Math.min(60, Math.max(1, Number(url.searchParams.get("fps")) || 25));
    let durationSec: number;
    try {
      durationSec = parseWavInfo(await req.arrayBuffer()).durationSec;
    } catch (err) {
      const message = err instanceof WavFormatError ? err.message : "音声を読めません";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const frameUs = 1_000_000 / fps;
    const total = Math.max(1, Math.ceil(durationSec * fps));
    const signal = req.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        await sleep(FIRST_FRAME_DELAY_MS);
        for (let i = 0; i < total; i++) {
          if (signal.aborted) return controller.close();
          controller.enqueue(
            encodeFrameMessage(
              {
                type: "frame",
                index: i,
                timestampUs: Math.round(i * frameUs),
                durationUs: Math.round(frameUs),
                mime: "image/png",
                width: src.width,
                height: src.height,
              },
              src.png,
            ),
          );
          await sleep((frameUs / 1000) * SPEED_RATIO);
        }
        controller.enqueue(encodeFrameMessage({ type: "end", frames: total }));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": FRAME_STREAM_MIME, "Cache-Control": "no-store" } });
  }

  return notFound();
}

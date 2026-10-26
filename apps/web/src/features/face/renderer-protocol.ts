/**
 * 展示PC ⇄ PC-A（顔を動かすサービス）のやり取りの形式。ブラウザ・Next のサーバー（試験用）・
 * Python（services/face-renderer）で同じ形式を使う。詳しくは services/face-renderer/PROTOCOL.md。
 *
 *   GET  {base}/health                         → JSON { status: "ok", backend, version }
 *   POST {base}/prepare   (multipart)          → JSON { sourceId, width, height }
 *          source   : 元画像（PNG。肩から上、背景は黒）
 *          landmarks: landmarks.json（任意）
 *          assetId  : 展示PC側の写真 ID（同じ ID ならキャッシュを使ってよい）
 *   POST {base}/speak?sourceId=..&fps=..  (body: audio/wav) → フレームの列（下記）
 *
 * フレームの列（Content-Type: application/x-face-frames）は次の「メッセージ」を順に並べたもの:
 *   [uint32 BE: ヘッダの長さ][ヘッダ: UTF-8 JSON][uint32 BE: 本体の長さ][本体: バイト列]
 * ヘッダ:
 *   { "type": "frame", "index": 0, "timestampUs": 0, "durationUs": 40000, "mime": "image/jpeg", "width": 1024, "height": 1024 }
 *   { "type": "end", "frames": 120 }            本体は空
 *   { "type": "error", "message": "..." }       本体は空
 * timestampUs は音声の先頭を 0 とした再生位置（マイクロ秒）。
 */
import { z } from "zod";

export const FRAME_STREAM_MIME = "application/x-face-frames";

export const healthSchema = z.object({ status: z.literal("ok"), backend: z.string(), version: z.string().optional() });
export const prepareResponseSchema = z.object({
  sourceId: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const frameHeaderSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("frame"),
    index: z.number().int().nonnegative(),
    timestampUs: z.number().nonnegative(),
    durationUs: z.number().positive(),
    mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({ type: z.literal("end"), frames: z.number().int().nonnegative() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type FrameHeader = z.infer<typeof frameHeaderSchema>;
export type FrameMessage = { header: FrameHeader; body: Uint8Array<ArrayBuffer> };

export class FrameStreamError extends Error {}

/** 1 メッセージをバイト列にする（試験用サーバー・テストで使う） */
export function encodeFrameMessage(header: FrameHeader, body: Uint8Array = new Uint8Array()): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + 4 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, h.length);
  out.set(h, 4);
  view.setUint32(4 + h.length, body.length);
  out.set(body, 8 + h.length);
  return out;
}

/** ヘッダ・本体の上限（壊れたデータで巨大な確保をしないため） */
const MAX_HEADER = 64 * 1024;
const MAX_BODY = 32 * 1024 * 1024;

/**
 * 届いた順にバイト列を渡すと、そろったメッセージから順に取り出せるパーサ。
 * ネットワークの区切りとメッセージの区切りは一致しないので、足りない分は次の push まで持ち越す。
 */
export class FrameStreamParser {
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(0);

  push(chunk: Uint8Array): FrameMessage[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const out: FrameMessage[] = [];
    let offset = 0;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    while (true) {
      if (this.buf.length - offset < 4) break;
      const headerLen = view.getUint32(offset);
      if (headerLen === 0 || headerLen > MAX_HEADER) throw new FrameStreamError(`ヘッダの長さが不正です: ${headerLen}`);
      if (this.buf.length - offset < 4 + headerLen + 4) break;
      const bodyLen = view.getUint32(offset + 4 + headerLen);
      if (bodyLen > MAX_BODY) throw new FrameStreamError(`本体が大きすぎます: ${bodyLen}`);
      const total = 4 + headerLen + 4 + bodyLen;
      if (this.buf.length - offset < total) break;

      const headerText = new TextDecoder().decode(this.buf.subarray(offset + 4, offset + 4 + headerLen));
      let json: unknown;
      try {
        json = JSON.parse(headerText);
      } catch {
        throw new FrameStreamError("ヘッダの JSON が壊れています");
      }
      const parsed = frameHeaderSchema.safeParse(json);
      if (!parsed.success) throw new FrameStreamError("ヘッダの形式が不正です");
      out.push({ header: parsed.data, body: this.buf.slice(offset + 8 + headerLen, offset + total) });
      offset += total;
    }
    this.buf = this.buf.slice(offset);
    return out;
  }

  /** 読み終わったときに、途中で切れたデータが残っていないか */
  get pendingBytes(): number {
    return this.buf.length;
  }
}

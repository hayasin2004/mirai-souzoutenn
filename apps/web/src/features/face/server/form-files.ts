import "server-only";
import type { FaceConfig } from "../config";
import { pngSize } from "../image-format";
import type { FaceRecord } from "../schema";
import type { BustFiles } from "./repository";

export async function bytesOf(v: FormDataEntryValue | null, max: number): Promise<Uint8Array | null> {
  if (!(v instanceof File) || v.size === 0 || v.size > max) return null;
  return new Uint8Array(await v.arrayBuffer());
}

const MAX_BUST_BYTES = 20 * 1024 * 1024;

/**
 * 肩から上の画像 2 枚（背景つき・切り抜き）を読む。どちらも無ければ null。
 * 片方だけ・大きさ違い・landmarks に bust 情報が無い、はエラー文を返す。
 */
export async function readBustFiles(
  form: FormData,
  keys: { bust: string; cutout: string },
  record: FaceRecord,
  config: FaceConfig,
): Promise<{ files: BustFiles | null; error: string | null }> {
  const [bustPng, cutoutPng] = await Promise.all([
    bytesOf(form.get(keys.bust), MAX_BUST_BYTES),
    bytesOf(form.get(keys.cutout), MAX_BUST_BYTES),
  ]);
  if (!bustPng && !cutoutPng) {
    return { files: null, error: record.bust ? "肩から上の画像がありません" : null };
  }
  if (!bustPng || !cutoutPng) return { files: null, error: "肩から上の画像が 1 枚しかありません" };
  if (!record.bust) return { files: null, error: "landmarks に肩から上の情報がありません" };
  const { outputWidth: w, outputHeight: h } = config.bust;
  for (const png of [bustPng, cutoutPng]) {
    const size = pngSize(png);
    if (!size || size.width !== w || size.height !== h) {
      return { files: null, error: `肩から上の画像は ${w}×${h} の PNG が必要です` };
    }
  }
  return { files: { bustPng, cutoutPng }, error: null };
}

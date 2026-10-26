import { NextResponse } from "next/server";
import { z } from "zod";
import { FACE_CONFIG } from "@/features/face/config";
import { isJpeg, pngSize } from "@/features/face/image-format";
import { qualityInputFromRecord } from "@/features/face/capture/session";
import { evaluateQuality } from "@/features/face/quality";
import { faceRecordSchema } from "@/features/face/schema";
import {
  ConsentRequiredError,
  NotFoundError,
  getActiveAsset,
  getPerson,
  saveFaceAsset,
} from "@/features/face/server/repository";
import { readBustFiles } from "@/features/face/server/form-files";
import { ID_PATTERN } from "@/lib/paths";

type Ctx = { params: Promise<{ personId: string }> };

const MAX_ORIGINAL_BYTES = 40 * 1024 * 1024;
const MAX_FACE_BYTES = 8 * 1024 * 1024;

const formSchema = z.object({
  original: z.instanceof(File).refine((f) => f.size > 0 && f.size <= MAX_ORIGINAL_BYTES, "元写真の大きさが不正です"),
  face: z.instanceof(File).refine((f) => f.size > 0 && f.size <= MAX_FACE_BYTES, "切り出し画像の大きさが不正です"),
  record: z.string().min(2),
});

function error(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/** 使用中の顔（展示画面用）。同意が無い人物は表示しない */
export async function GET(_req: Request, { params }: Ctx) {
  const { personId } = await params;
  if (!ID_PATTERN.test(personId)) return error(400, "不正な ID です");
  const person = getPerson(personId);
  if (!person) return error(404, "人物が見つかりません");
  const active = person.consentAt ? getActiveAsset(personId) : null;
  return NextResponse.json({
    person: { id: person.id, name: person.name },
    active: active
      ? {
          assetId: active.id,
          faceUrl: `/api/face-assets/${active.id}/face.png`,
          landmarksUrl: `/api/face-assets/${active.id}/landmarks.json`,
          bustUrl: active.bustPath ? `/api/face-assets/${active.id}/bust.png` : null,
          bustCutoutUrl: active.bustCutoutPath ? `/api/face-assets/${active.id}/bust_cutout.png` : null,
        }
      : null,
  });
}

/** 顔写真の保存。ブラウザで解析した結果を受け取り、サーバーでも検証してから保存する */
export async function POST(req: Request, { params }: Ctx) {
  const { personId } = await params;
  if (!ID_PATTERN.test(personId)) return error(400, "不正な ID です");

  const formData = await req.formData();
  const form = formSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!form.success) return error(400, "送信内容が不正です", { issues: z.treeifyError(form.error) });

  let json: unknown;
  try {
    json = JSON.parse(form.data.record);
  } catch {
    return error(400, "landmarks の JSON が壊れています");
  }
  const parsed = faceRecordSchema.safeParse(json);
  if (!parsed.success) return error(400, "landmarks の形式が不正です", { issues: z.treeifyError(parsed.error) });
  const record = parsed.data;

  // 品質チェックはサーバーの設定でやり直す（ブラウザ側の判定はそのまま信用しない）
  const quality = evaluateQuality(qualityInputFromRecord(record));
  if (quality.status === "fail") return error(422, "品質チェックで不合格の写真は保存できません", { quality });

  const [original, face] = await Promise.all([
    form.data.original.arrayBuffer().then((b) => new Uint8Array(b)),
    form.data.face.arrayBuffer().then((b) => new Uint8Array(b)),
  ]);
  if (!isJpeg(original)) return error(400, "元写真が JPEG ではありません");
  const size = pngSize(face);
  const expected = FACE_CONFIG.crop.outputSize;
  if (!size || size.width !== expected || size.height !== expected) {
    return error(400, `切り出し画像は ${expected}×${expected} の PNG が必要です`);
  }
  const bust = await readBustFiles(formData, { bust: "bust", cutout: "bustCutout" }, record, FACE_CONFIG);
  if (bust.error) return error(400, bust.error);

  try {
    const asset = await saveFaceAsset({
      personId,
      originalJpeg: original,
      facePng: face,
      landmarksJson: JSON.stringify({ ...record, quality, thresholds: FACE_CONFIG }, null, 2),
      bust: bust.files,
      qualityStatus: quality.status,
    });
    return NextResponse.json({ asset, quality }, { status: 201 });
  } catch (err) {
    if (err instanceof NotFoundError) return error(404, err.message);
    if (err instanceof ConsentRequiredError) return error(403, err.message);
    throw err;
  }
}

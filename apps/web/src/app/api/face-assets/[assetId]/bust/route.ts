import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { FACE_CONFIG } from "@/features/face/config";
import { faceRecordSchema } from "@/features/face/schema";
import { readBustFiles } from "@/features/face/server/form-files";
import { FACE_FILES, getAsset, getPerson, setAssetBust } from "@/features/face/server/repository";
import { ID_PATTERN, resolveDataPath } from "@/lib/paths";

type Ctx = { params: Promise<{ assetId: string }> };

const bustSchema = faceRecordSchema.shape.bust.unwrap();

/**
 * 保存済みの顔から、後で肩から上の画像を作って足す（この機能より前に保存したデータ用）。
 * ブラウザで元画像とランドマークから作った bust.png / bust_cutout.png と、その情報（bust）を受け取る。
 */
export async function POST(req: Request, { params }: Ctx) {
  const { assetId } = await params;
  if (!ID_PATTERN.test(assetId)) return NextResponse.json({ error: "不正な ID です" }, { status: 400 });
  const asset = getAsset(assetId);
  if (!asset) return NextResponse.json({ error: "見つかりません" }, { status: 404 });
  const person = getPerson(asset.personId);
  if (!person?.consentAt) return NextResponse.json({ error: "本人の同意が記録されていません" }, { status: 403 });

  const form = await req.formData();
  const bustJson = form.get("bust");
  let bust;
  try {
    bust = bustSchema.parse(JSON.parse(typeof bustJson === "string" ? bustJson : ""));
  } catch {
    return NextResponse.json({ error: "bust の形式が不正です" }, { status: 400 });
  }

  // landmarks.json に bust を足す
  const landmarksPath = resolveDataPath(asset.landmarksPath);
  const record = faceRecordSchema.safeParse(JSON.parse(await readFile(landmarksPath, "utf8")));
  if (!record.success) return NextResponse.json({ error: "保存済みの landmarks.json を読めません" }, { status: 500 });
  const updated = { ...record.data, bust };

  const files = await readBustFiles(form, { bust: "bustPng", cutout: "bustCutoutPng" }, updated, FACE_CONFIG);
  if (files.error || !files.files) return NextResponse.json({ error: files.error ?? "画像がありません" }, { status: 400 });

  const relDir = path.posix.dirname(asset.facePath);
  const absDir = resolveDataPath(relDir);
  await Promise.all([
    writeFile(path.join(/*turbopackIgnore: true*/ absDir, FACE_FILES.bust), files.files.bustPng),
    writeFile(path.join(/*turbopackIgnore: true*/ absDir, FACE_FILES.bustCutout), files.files.cutoutPng),
    writeFile(landmarksPath, JSON.stringify(updated, null, 2), "utf8"),
  ]);
  setAssetBust(assetId, path.posix.join(relDir, FACE_FILES.bust), path.posix.join(relDir, FACE_FILES.bustCutout));
  return NextResponse.json({ ok: true });
}

import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { FACE_FILES, getAsset } from "@/features/face/server/repository";
import { ID_PATTERN, resolveDataPath } from "@/lib/paths";

type Ctx = { params: Promise<{ assetId: string; file: string }> };

const FILES = {
  [FACE_FILES.face]: { column: "facePath", type: "image/png" },
  [FACE_FILES.original]: { column: "sourcePhotoPath", type: "image/jpeg" },
  [FACE_FILES.landmarks]: { column: "landmarksPath", type: "application/json; charset=utf-8" },
  [FACE_FILES.bust]: { column: "bustPath", type: "image/png" },
  [FACE_FILES.bustCutout]: { column: "bustCutoutPath", type: "image/png" },
} as const;

/** 保存した顔データを配信する。data/ は public/ の外にあるのでここを通す */
export async function GET(_req: Request, { params }: Ctx) {
  const { assetId, file } = await params;
  if (!ID_PATTERN.test(assetId) || !Object.hasOwn(FILES, file)) {
    return NextResponse.json({ error: "見つかりません" }, { status: 404 });
  }
  const spec = FILES[file as keyof typeof FILES];
  const asset = getAsset(assetId);
  if (!asset) return NextResponse.json({ error: "見つかりません" }, { status: 404 });

  const rel = asset[spec.column];
  if (!rel) return NextResponse.json({ error: "見つかりません" }, { status: 404 });
  try {
    const body = await readFile(resolveDataPath(rel));
    return new NextResponse(body, {
      headers: {
        "Content-Type": spec.type,
        // 削除した顔がブラウザのキャッシュに残らないようにする
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "ファイルがありません" }, { status: 404 });
  }
}

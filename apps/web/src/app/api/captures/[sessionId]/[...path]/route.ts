import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { STEP_ID_PATTERN } from "@/features/face/capture/session-schema";
import { SESSION_FILE, STEP_FILES, getCaptureSession } from "@/features/face/server/repository";
import { ID_PATTERN, resolveDataPath } from "@/lib/paths";

type Ctx = { params: Promise<{ sessionId: string; path: string[] }> };

const TYPES: Record<string, string> = {
  [STEP_FILES.original]: "image/jpeg",
  [STEP_FILES.face]: "image/png",
  [STEP_FILES.landmarks]: "application/json; charset=utf-8",
  [STEP_FILES.timeline]: "application/json; charset=utf-8",
  [STEP_FILES.video]: "video/webm",
  [STEP_FILES.bust]: "image/png",
  [STEP_FILES.bustCutout]: "image/png",
};

const notFound = () => NextResponse.json({ error: "見つかりません" }, { status: 404 });

/**
 * カメラ撮影のファイルを配信する。
 *   /api/captures/<sessionId>/session.json
 *   /api/captures/<sessionId>/<stepId>/<face.png | original.jpg | landmarks.json | timeline.json | clip.webm>
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { sessionId, path: parts } = await params;
  if (!ID_PATTERN.test(sessionId)) return notFound();
  const session = getCaptureSession(sessionId);
  if (!session) return notFound();

  let rel: string;
  let type: string;
  if (parts.length === 1 && parts[0] === SESSION_FILE) {
    rel = session.sessionPath;
    type = "application/json; charset=utf-8";
  } else if (parts.length === 2 && STEP_ID_PATTERN.test(parts[0]!) && Object.hasOwn(TYPES, parts[1]!)) {
    rel = path.posix.join(session.dirPath, parts[0]!, parts[1]!);
    type = TYPES[parts[1]!]!;
  } else {
    return notFound();
  }

  try {
    const body = await readFile(resolveDataPath(rel));
    return new NextResponse(body, { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
  } catch {
    return notFound();
  }
}

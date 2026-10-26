import { NextResponse } from "next/server";
import { z } from "zod";
import { FACE_CONFIG } from "@/features/face/config";
import { type SessionRecord, sessionRecordSchema } from "@/features/face/capture/session-schema";
import {
  type RecordedStepData,
  analyzeSession,
  combineLevels,
  evaluateRecordedStep,
  missingRequiredSteps,
} from "@/features/face/capture/session";
import { decodeTimeline, timelineSchema } from "@/features/face/capture/timeline";
import { isJpeg, isWebm, pngSize } from "@/features/face/image-format";
import { faceRecordSchema } from "@/features/face/schema";
import {
  type CaptureStepFiles,
  ConsentRequiredError,
  NotFoundError,
  saveCaptureSession,
} from "@/features/face/server/repository";
import { bytesOf, readBustFiles } from "@/features/face/server/form-files";
import { ID_PATTERN } from "@/lib/paths";

type Ctx = { params: Promise<{ personId: string }> };

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

function error(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

function parseJson<T>(v: FormDataEntryValue | null, schema: z.ZodType<T>): T | null {
  if (typeof v !== "string") return null;
  try {
    const r = schema.safeParse(JSON.parse(v));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * カメラ撮影 1 回分の保存。フォームの項目:
 *   session                     session.json（JSON 文字列）
 *   step:<id>:original / face   キーフレームの JPEG / 512×512 PNG
 *   step:<id>:landmarks         landmarks.json（JSON 文字列）
 *   step:<id>:timeline          timeline.json（JSON 文字列）
 *   step:<id>:video             その段階の録画（WebM、任意）
 *   step:<id>:bust / bustCutout 肩から上の画像（正面の段階だけ）
 */
export async function POST(req: Request, { params }: Ctx) {
  const { personId } = await params;
  if (!ID_PATTERN.test(personId)) return error(400, "不正な ID です");
  const form = await req.formData();

  const session = parseJson(form.get("session"), sessionRecordSchema);
  if (!session) return error(400, "session の形式が不正です");

  const config = FACE_CONFIG;
  const stepConfigs = new Map(config.capture.steps.map((s) => [s.id, s]));
  const recordedIds = new Set(session.steps.filter((s) => s.status === "recorded").map((s) => s.id));
  for (const s of session.steps) {
    if (!stepConfigs.has(s.id)) return error(400, `知らない段階です: ${s.id}`);
  }
  const missing = missingRequiredSteps(config.capture.steps, recordedIds);
  if (missing.length > 0) return error(422, `記録されていない段階があります: ${missing.map((s) => s.label).join("、")}`);
  const frontStep = config.capture.steps.find((s) => s.kind === "front");
  if (!frontStep || !recordedIds.has(frontStep.id)) return error(422, "正面の段階がありません");

  // 段階ごとにファイルを検証し、サーバーで判定をやり直す
  const files: CaptureStepFiles[] = [];
  const recorded: RecordedStepData[] = [];
  const stepRecords: SessionRecord["steps"] = [];
  const levels: ("pass" | "warn" | "fail")[] = [];
  let frontLevel: "pass" | "warn" = "pass";

  for (const s of session.steps) {
    const step = stepConfigs.get(s.id)!;
    if (s.status === "skipped") {
      if (!step.optional) return error(422, `「${step.label}」は省略できません`);
      stepRecords.push(s);
      continue;
    }
    const key = (name: string) => `step:${s.id}:${name}`;
    const [original, face, video] = await Promise.all([
      bytesOf(form.get(key("original")), MAX_IMAGE_BYTES),
      bytesOf(form.get(key("face")), MAX_IMAGE_BYTES),
      bytesOf(form.get(key("video")), MAX_VIDEO_BYTES),
    ]);
    if (!original || !isJpeg(original)) return error(400, `「${step.label}」の元画像が JPEG ではありません`);
    const size = pngSize(face ?? new Uint8Array());
    const out = config.crop.outputSize;
    if (!face || !size || size.width !== out || size.height !== out) {
      return error(400, `「${step.label}」の切り出し画像は ${out}×${out} の PNG が必要です`);
    }
    if (video && !isWebm(video)) return error(400, `「${step.label}」の録画が WebM ではありません`);
    const record = parseJson(form.get(key("landmarks")), faceRecordSchema);
    if (!record || record.capture?.stepId !== s.id) return error(400, `「${step.label}」の landmarks の形式が不正です`);
    const timeline = parseJson(form.get(key("timeline")), timelineSchema);
    if (!timeline) return error(400, `「${step.label}」の timeline の形式が不正です`);
    const bust =
      step.kind === "front"
        ? await readBustFiles(form, { bust: key("bust"), cutout: key("bustCutout") }, record, config)
        : { files: null, error: null };
    if (bust.error) return error(400, `「${step.label}」: ${bust.error}`);

    const data: RecordedStepData = {
      step,
      record,
      samples: decodeTimeline(timeline),
      hold: s.hold,
      belowTarget: s.belowTarget,
    };
    const ev = evaluateRecordedStep(data, config);
    if (ev.level === "fail") {
      return error(422, `「${step.label}」が品質チェックで不合格です。撮り直してください`, { step: s.id, quality: ev.quality, temporal: ev.temporal });
    }
    levels.push(ev.level);
    if (step.kind === "front") frontLevel = ev.quality.status === "warn" ? "warn" : "pass";
    recorded.push(data);
    stepRecords.push({ ...s, quality: ev.quality, temporal: ev.temporal, hasVideo: video !== null });
    files.push({
      stepId: s.id,
      originalJpeg: original,
      facePng: face,
      landmarksJson: JSON.stringify({ ...record, quality: ev.quality, thresholds: config }, null, 2),
      timelineJson: JSON.stringify(timeline),
      video,
      bust: bust.files,
    });
  }

  const analysis = analyzeSession(recorded, config);
  const finalSession: SessionRecord = {
    ...session,
    steps: stepRecords,
    expressionRange: analysis.expressionRange,
    motionProfile: analysis.motionProfile,
    thresholds: config as unknown as Record<string, unknown>,
  };
  const status = combineLevels(levels);

  try {
    const saved = await saveCaptureSession({
      personId,
      sessionJson: JSON.stringify(finalSession, null, 2),
      qualityStatus: status === "fail" ? "warn" : status,
      frontStepId: frontStep.id,
      frontQualityStatus: frontLevel,
      steps: files,
    });
    return NextResponse.json({ ...saved, status }, { status: 201 });
  } catch (err) {
    if (err instanceof NotFoundError) return error(404, err.message);
    if (err instanceof ConsentRequiredError) return error(403, err.message);
    throw err;
  }
}

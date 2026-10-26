import { z } from "zod";
import { qualityReportSchema } from "../schema";

const finite = z.number().refine(Number.isFinite);
const statsSchema = z.object({ mean: z.number(), std: z.number(), min: z.number(), max: z.number(), count: z.number() });

export const STEP_ID_PATTERN = /^[A-Za-z0-9_]{1,32}$/;

export const temporalReportSchema = z.object({
  status: z.enum(["pass", "warn", "fail"]),
  checks: qualityReportSchema.shape.checks,
  frames: z.number().int().nonnegative(),
  durationMs: finite,
  faceLostRatio: finite,
  maxAngularSpeed: finite.nullable(),
  luminanceStd: finite.nullable(),
  blinkCount: z.number().int().nonnegative(),
});

export const captureStepRecordSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("recorded"),
    id: z.string().regex(STEP_ID_PATTERN),
    label: z.string(),
    kind: z.enum(["front", "pose", "expression", "free"]),
    /** 目標に届かないまま「今の最大値で記録」したとき true */
    belowTarget: z.boolean(),
    /** 記録に使った区間（段階の開始からの ms） */
    hold: z.object({ fromT: finite, toT: finite }),
    keyframeT: finite,
    /** 目標に対する値（向き=度, 表情=0〜1）。front / free は null */
    targetValue: finite.nullable(),
    quality: qualityReportSchema,
    temporal: temporalReportSchema,
    hasVideo: z.boolean(),
  }),
  z.object({
    status: z.literal("skipped"),
    id: z.string().regex(STEP_ID_PATTERN),
    label: z.string(),
    kind: z.enum(["front", "pose", "expression", "free"]),
  }),
]);

export const motionProfileSchema = z.object({
  durationSec: finite,
  blinkPerMinute: finite,
  yaw: statsSchema,
  pitch: statsSchema,
  roll: statsSchema,
  angularSpeed: statsSchema,
  swayX: finite,
  swayY: finite,
  blendshapes: z.record(z.string(), statsSchema),
});

export const sessionRecordSchema = z.object({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  camera: z.object({
    label: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frameRate: finite.nullable(),
    videoMimeType: z.string().nullable(),
  }),
  steps: z.array(captureStepRecordSchema).min(1),
  expressionRange: z.object({
    neutral: z.record(z.string(), finite),
    peaks: z.record(z.string(), z.record(z.string(), finite)),
  }),
  motionProfile: motionProfileSchema.nullable(),
  thresholds: z.record(z.string(), z.unknown()),
});

export type CaptureStepRecord = z.infer<typeof captureStepRecordSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

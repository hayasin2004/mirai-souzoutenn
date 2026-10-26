"use client";

import type { FaceConfig } from "../config";
import type { StepOutcome } from "./engine";
import { type RecordedStepData, analyzeSession, evaluateRecordedStep } from "./session";
import type { SessionRecord } from "./session-schema";
import { encodeTimeline } from "./timeline";

export type CameraInfo = SessionRecord["camera"];

export function toRecordedStepData(o: Extract<StepOutcome, { status: "recorded" }>): RecordedStepData {
  return { step: o.step, record: o.keyframe.record, samples: o.samples, hold: o.hold, belowTarget: o.belowTarget };
}

/**
 * 撮影結果から session.json と送信フォームを作る。
 * 記録していない省略可能な段階は skipped として送る。
 */
export function buildCaptureForm(
  outcomes: ReadonlyMap<string, StepOutcome>,
  camera: CameraInfo,
  config: FaceConfig,
): FormData {
  const form = new FormData();
  const steps: SessionRecord["steps"] = [];
  const recorded: RecordedStepData[] = [];

  for (const step of config.capture.steps) {
    const o = outcomes.get(step.id);
    if (!o || o.status === "skipped") {
      steps.push({ status: "skipped", id: step.id, label: step.label, kind: step.kind });
      continue;
    }
    const data = toRecordedStepData(o);
    const ev = evaluateRecordedStep(data, config);
    recorded.push(data);
    steps.push({
      status: "recorded",
      id: step.id,
      label: step.label,
      kind: step.kind,
      belowTarget: o.belowTarget,
      hold: o.hold,
      keyframeT: o.keyframe.t,
      targetValue: o.targetValue,
      quality: ev.quality,
      temporal: ev.temporal,
      hasVideo: o.video !== null,
    });
    const key = (name: string) => `step:${step.id}:${name}`;
    form.append(key("original"), o.keyframe.originalJpeg, "original.jpg");
    form.append(key("face"), o.keyframe.facePng, "face.png");
    form.append(key("landmarks"), JSON.stringify(o.keyframe.record));
    form.append(key("timeline"), JSON.stringify(encodeTimeline(o.samples)));
    if (o.video) form.append(key("video"), o.video, "clip.webm");
    if (o.keyframe.bust) {
      form.append(key("bust"), o.keyframe.bust.bustPng, "bust.png");
      form.append(key("bustCutout"), o.keyframe.bust.cutoutPng, "bust_cutout.png");
    }
  }

  const analysis = analyzeSession(recorded, config);
  const session: SessionRecord = {
    version: 1,
    createdAt: new Date().toISOString(),
    camera,
    steps,
    expressionRange: analysis.expressionRange,
    motionProfile: analysis.motionProfile,
    thresholds: config as unknown as Record<string, unknown>,
  };
  form.append("session", JSON.stringify(session));
  return form;
}

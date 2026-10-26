"use client";

import { useState } from "react";
import { type CaptureStep, FACE_CONFIG } from "../config";
import type { StepOutcome } from "../capture/engine";
import { type StepEvaluation, analyzeSession } from "../capture/session";
import { toRecordedStepData } from "../capture/upload";
import type { QualityLevel } from "../quality";
import { BustPreview } from "./BustPreview";
import { LevelBadge } from "./QualityReportView";

export type ReviewItem =
  | { step: CaptureStep; state: "pending" }
  | { step: CaptureStep; state: "skipped" }
  | {
      step: CaptureStep;
      state: "recorded";
      outcome: Extract<StepOutcome, { status: "recorded" }>;
      evaluation: StepEvaluation;
      faceUrl: string;
      videoUrl: string | null;
      bustUrl: string | null;
    };

type Props = {
  items: ReviewItem[];
  overall: QualityLevel;
  missing: CaptureStep[];
  saving: boolean;
  onRetake: (step: CaptureStep) => void;
  onContinue: (step: CaptureStep) => void;
  onSave: () => void;
  onDiscard: () => void;
};

function targetText(item: Extract<ReviewItem, { state: "recorded" }>): string | null {
  const v = item.outcome.targetValue;
  if (v === null) return null;
  if (item.step.kind === "pose") return `${v.toFixed(1)}°`;
  return v.toFixed(2);
}

export function CaptureReview({ items, overall, missing, saving, onRetake, onContinue, onSave, onDiscard }: Props) {
  const [ack, setAck] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const recorded = items.filter((i): i is Extract<ReviewItem, { state: "recorded" }> => i.state === "recorded");
  const summary = analyzeSession(recorded.map((r) => toRecordedStepData(r.outcome)), FACE_CONFIG);
  const firstMissing = items.find((i) => i.state === "pending");
  const canSave = missing.length === 0 && recorded.length > 0 && overall !== "fail" && (overall === "pass" || ack) && !saving;

  return (
    <div className="space-y-5">
      <div className="panel flex flex-wrap items-center gap-4 p-4">
        <LevelBadge level={recorded.length ? overall : "skip"} />
        <p className="text-sm">
          {missing.length > 0
            ? `まだ撮っていない段階があります：${missing.map((s) => s.label).join("、")}`
            : overall === "fail"
              ? "不合格の段階があります。「撮り直す」で、その段階だけ撮り直してください"
              : overall === "warn"
                ? "注意の段階があります（保存はできます）"
                : "すべての段階が合格です"}
        </p>
        {firstMissing && (
          <button type="button" className="btn btn-primary ml-auto" onClick={() => onContinue(firstMissing.step)}>
            「{firstMissing.step.label}」から続きを撮る
          </button>
        )}
      </div>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item) => (
          <li key={item.step.id} className="panel flex flex-col gap-2 p-2">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm">{item.step.label}</p>
              {item.state === "recorded" ? <LevelBadge level={item.evaluation.level} /> : <span className="label">{item.state === "skipped" ? "省略" : "未撮影"}</span>}
            </div>

            {item.state === "recorded" ? (
              <>
                <div className="relative aspect-square overflow-hidden bg-black">
                  {playing === item.step.id && item.videoUrl ? (
                    <video src={item.videoUrl} controls autoPlay muted className="size-full -scale-x-100 object-contain" />
                  ) : (
                    <img src={item.faceUrl} alt={`${item.step.label} の顔`} className="size-full" />
                  )}
                </div>
                <p className="font-mono text-[11px] text-ink-dim">
                  {targetText(item) && <>値 {targetText(item)} · </>}
                  {(item.outcome.temporal.durationMs / 1000).toFixed(1)}s · {item.outcome.samples.length}f
                </p>
                {item.outcome.belowTarget && <p className="text-xs text-warn">目標に届かないまま記録</p>}
                <ul className="space-y-0.5 text-xs">
                  {[...item.evaluation.quality.checks, ...item.evaluation.temporal.checks]
                    .filter((c) => c.level === "fail" || c.level === "warn")
                    .map((c) => (
                      <li key={c.id} className={c.level === "fail" ? "text-ng" : "text-warn"} title={c.tip ?? undefined}>
                        ▸ {c.label}
                      </li>
                    ))}
                </ul>
                <div className="mt-auto flex flex-wrap gap-1.5">
                  {item.videoUrl && (
                    <button
                      type="button"
                      className="btn px-2 py-1 text-xs"
                      onClick={() => setPlaying(playing === item.step.id ? null : item.step.id)}
                    >
                      {playing === item.step.id ? "画像" : "動画"}
                    </button>
                  )}
                  <button type="button" className="btn px-2 py-1 text-xs" onClick={() => onRetake(item.step)}>
                    撮り直す
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex aspect-square items-center justify-center border border-dashed border-line text-xs text-ink-dim">
                  {item.state === "skipped" ? "SKIPPED" : "NO DATA"}
                </div>
                <button type="button" className="btn mt-auto px-2 py-1 text-xs" onClick={() => onRetake(item.step)}>
                  撮る
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      {recorded
        .filter((r) => r.bustUrl && r.outcome.keyframe.bust)
        .map((r) => (
          <div key={r.step.id} className="max-w-xs">
            <BustPreview url={r.bustUrl!} personCoverage={r.outcome.keyframe.bust!.personCoverage} />
          </div>
        ))}

      {(summary.motionProfile || Object.keys(summary.expressionRange.peaks).length > 0) && (
        <div className="panel grid gap-4 p-4 sm:grid-cols-2">
          {Object.keys(summary.expressionRange.peaks).length > 0 && (
            <div className="space-y-1">
              <p className="label">EXPRESSION RANGE</p>
              <table className="w-full font-mono text-xs">
                <tbody>
                  {recorded
                    .filter((r) => r.step.kind === "expression" && r.step.expression)
                    .map((r) => {
                      const names = r.step.expression!.names;
                      const peak = names.reduce((s, n) => s + (summary.expressionRange.peaks[r.step.id]?.[n] ?? 0), 0) / names.length;
                      const base = names.reduce((s, n) => s + (summary.expressionRange.neutral[n] ?? 0), 0) / names.length;
                      return (
                        <tr key={r.step.id} className="border-t border-line">
                          <td className="py-1 font-sans">{r.step.label}</td>
                          <td className="py-1 text-right text-ink-dim">真顔 {base.toFixed(2)}</td>
                          <td className="py-1 text-right">→ 最大 {peak.toFixed(2)}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
          {summary.motionProfile && (
            <div className="space-y-1">
              <p className="label">MOTION PROFILE</p>
              <dl className="grid grid-cols-2 gap-y-1 font-mono text-xs">
                <dt className="text-ink-dim">まばたき</dt>
                <dd>{summary.motionProfile.blinkPerMinute.toFixed(1)} 回/分</dd>
                <dt className="text-ink-dim">左右の揺れ</dt>
                <dd>±{summary.motionProfile.yaw.std.toFixed(1)}°</dd>
                <dt className="text-ink-dim">上下の揺れ</dt>
                <dd>±{summary.motionProfile.pitch.std.toFixed(1)}°</dd>
                <dt className="text-ink-dim">首の傾き</dt>
                <dd>±{summary.motionProfile.roll.std.toFixed(1)}°</dd>
                <dt className="text-ink-dim">平均の速さ</dt>
                <dd>{summary.motionProfile.angularSpeed.mean.toFixed(1)}°/s</dd>
              </dl>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {overall === "warn" && missing.length === 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-warn" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            注意の段階を確認したうえで保存する
          </label>
        )}
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={onSave}>
          {saving ? "保存中…" : "保存して使用中にする"}
        </button>
        <button type="button" className="btn btn-danger" disabled={saving} onClick={onDiscard}>
          破棄してやめる
        </button>
      </div>
    </div>
  );
}

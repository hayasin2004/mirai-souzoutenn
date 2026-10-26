"use client";

import type { CaptureStep, FaceConfig } from "../config";
import type { LiveState } from "../capture/engine";
import { subjectPose } from "../capture/step-eval";

type Props = {
  step: CaptureStep;
  index: number;
  total: number;
  live: LiveState | null;
  config: FaceConfig;
  onAcceptBest: () => void;
  onSkip: () => void;
  onCancel: () => void;
};

/** 撮影中の案内：指示・目標までの距離・記録の進み具合・問題点 */
export function LiveGuide({ step, index, total, live, config, onAcceptBest, onSkip, onCancel }: Props) {
  const issues = live?.quality.checks.filter((c) => c.level === "fail" || c.level === "warn") ?? [];
  const tooFast =
    step.kind !== "free" &&
    live?.angularSpeed != null &&
    live.angularSpeed > config.capture.motion.angularSpeedDegPerSec.pass;
  const remainingSec = step.kind === "free" && live ? Math.max(0, step.holdSec - live.t / 1000) : null;

  return (
    <div className="panel space-y-5 p-5">
      <div className="flex items-baseline justify-between">
        <p className="label">
          STEP {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")} · {step.label}
        </p>
        {live && <p className="font-mono text-[11px] text-ink-dim">{live.fps} fps</p>}
      </div>

      <div className="flex items-center gap-5">
        <HoldRing progress={live?.holdProgress ?? 0} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-lg leading-snug">{step.instruction}</p>
          <p className="h-5 text-sm text-warn">
            {!live
              ? "顔を探しています…"
              : (live.target.hint ?? (tooFast ? "ゆっくり、止まってください" : issues[0] ? issues[0].label + "を確認" : ""))}
          </p>
          {remainingSec !== null && <p className="font-mono text-sm text-holo">残り {remainingSec.toFixed(1)} 秒</p>}
        </div>
      </div>

      {(step.kind === "pose" || step.kind === "front") && <PosePad step={step} live={live} config={config} />}
      {step.kind === "expression" && step.expression && (
        <Meter value={live?.target.value ?? 0} goal={step.expression.min} label={step.expression.names.join(" + ")} />
      )}

      {issues.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {issues.map((c) => (
            <li
              key={c.id}
              className={`rounded-sm border px-2 py-0.5 text-xs ${c.level === "fail" ? "border-ng/50 text-ng" : "border-warn/40 text-warn"}`}
            >
              {c.label}
            </li>
          ))}
        </ul>
      )}

      {live?.timedOut && (
        <div className="space-y-2 rounded-sm border border-warn/40 p-3 text-sm">
          <p className="text-warn">うまく記録できていません。</p>
          <ul className="space-y-1 text-ink-dim">
            {issues
              .filter((c) => c.tip)
              .slice(0, 3)
              .map((c) => (
                <li key={c.id}>▸ {c.tip}</li>
              ))}
            {step.kind === "expression" && <li>▸ 表情は人それぞれです。できる範囲で大きく動かせば十分です。</li>}
          </ul>
          {live.canAcceptBest && (
            <button type="button" className="btn" onClick={onAcceptBest}>
              今までで一番よい瞬間で記録する（注意つき）
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {step.optional && (
          <button type="button" className="btn" onClick={onSkip}>
            この段階を省略
          </button>
        )}
        <button type="button" className="btn btn-danger" onClick={onCancel}>
          中止
        </button>
      </div>
    </div>
  );
}

function HoldRing({ progress }: { progress: number }) {
  const r = 26;
  const len = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 64 64" className="size-16 shrink-0 -rotate-90" aria-label={`記録 ${Math.round(progress * 100)}%`}>
      <circle cx="32" cy="32" r={r} fill="none" stroke="rgb(120 200 230 / 0.18)" strokeWidth="3" />
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        stroke="#7fe3ff"
        strokeWidth="3"
        strokeDasharray={len}
        strokeDashoffset={len * (1 - progress)}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 顔の向きを 2 次元で表示する。画面は鏡のように反転しているので、本人の左 = 画面の左。
 * 目標の範囲を枠で、今の向きを点で示す。
 */
function PosePad({ step, live, config }: { step: CaptureStep; live: LiveState | null; config: FaceConfig }) {
  const R = 40; // 表示する範囲（±度）
  const toX = (left: number) => 50 - (left / R) * 50; // 本人の左 → 画面の左
  const toY = (up: number) => 50 - (up / R) * 50;
  const q = config.quality;

  let box: { x0: number; x1: number; y0: number; y1: number };
  const p = step.pose;
  const off = 12;
  if (step.kind === "front" || !p) box = { x0: -q.yawDeg.pass, x1: q.yawDeg.pass, y0: -q.pitchDeg.pass, y1: q.pitchDeg.pass };
  else if (p.direction === "left") box = { x0: p.minDeg, x1: p.maxDeg, y0: -off, y1: off };
  else if (p.direction === "right") box = { x0: -p.maxDeg, x1: -p.minDeg, y0: -off, y1: off };
  else if (p.direction === "up") box = { x0: -off, x1: off, y0: p.minDeg, y1: p.maxDeg };
  else box = { x0: -off, x1: off, y0: -p.maxDeg, y1: -p.minDeg };

  const sp = live?.sample.pose ? subjectPose(live.sample.pose, config.capture.poseSign) : null;
  const inBox = live?.target.met ?? false;

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 100 100" className="size-32 shrink-0 rounded-sm border border-line bg-black/30">
        <line x1="50" y1="0" x2="50" y2="100" stroke="rgb(120 200 230 / 0.18)" strokeWidth="0.5" />
        <line x1="0" y1="50" x2="100" y2="50" stroke="rgb(120 200 230 / 0.18)" strokeWidth="0.5" />
        <rect
          x={Math.min(toX(box.x0), toX(box.x1))}
          y={Math.min(toY(box.y0), toY(box.y1))}
          width={Math.abs(toX(box.x1) - toX(box.x0))}
          height={Math.abs(toY(box.y1) - toY(box.y0))}
          fill="rgb(127 227 255 / 0.08)"
          stroke="rgb(127 227 255 / 0.6)"
          strokeWidth="0.6"
        />
        {sp && (
          <circle
            cx={Math.max(2, Math.min(98, toX(sp.left)))}
            cy={Math.max(2, Math.min(98, toY(sp.up)))}
            r="3"
            fill={inBox ? "#6be0a8" : "#f2c25c"}
          />
        )}
      </svg>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
        <dt className="text-ink-dim">左右</dt>
        <dd>{sp ? `${sp.left >= 0 ? "左" : "右"} ${Math.abs(sp.left).toFixed(1)}°` : "—"}</dd>
        <dt className="text-ink-dim">上下</dt>
        <dd>{sp ? `${sp.up >= 0 ? "上" : "下"} ${Math.abs(sp.up).toFixed(1)}°` : "—"}</dd>
        <dt className="text-ink-dim">速さ</dt>
        <dd>{live?.angularSpeed != null ? `${live.angularSpeed.toFixed(0)}°/s` : "—"}</dd>
      </dl>
    </div>
  );
}

function Meter({ value, goal, label }: { value: number; goal: number; label: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="space-y-1">
      <div className="flex justify-between font-mono text-xs text-ink-dim">
        <span>{label}</span>
        <span>
          {value.toFixed(2)} / {goal.toFixed(2)}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-line">
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${value >= goal ? "bg-ok" : "bg-holo"}`}
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-y-[-3px] w-px bg-ink" style={{ left: `${goal * 100}%` }} />
      </div>
    </div>
  );
}

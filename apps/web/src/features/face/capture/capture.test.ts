import { describe, expect, it } from "vitest";
import { type CaptureStep, FACE_CONFIG } from "../config";
import { evaluateQuality } from "../quality";
import { evaluateTarget, expressionValue, frameQuality, poseTowards, subjectPose } from "./step-eval";
import {
  angularSpeeds,
  countBlinks,
  evaluateTemporal,
  expressionRange,
  frameScore,
  holdProgress,
  motionProfile,
  stats,
  updateHold,
} from "./temporal";
import type { FrameSample } from "./types";

const CAP = FACE_CONFIG.capture;
const step = (id: string): CaptureStep => {
  const s = CAP.steps.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};

function sample(t: number, over: Partial<FrameSample> = {}): FrameSample {
  return {
    t,
    faceCount: 1,
    pose: { yaw: 0, pitch: 0, roll: 0 },
    blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05, jawOpen: 0.02 },
    faceWidthPx: 500,
    center: { x: 960, y: 540 },
    meanLuminance: 120,
    laplacianVariance: 200,
    metricsMeasured: true,
    cropOutsideRatio: 0,
    ...over,
  };
}

/** 30fps で n フレーム */
const frames = (n: number, f: (i: number) => Partial<FrameSample> = () => ({})) =>
  Array.from({ length: n }, (_, i) => sample((i * 1000) / 30, f(i)));

describe("向きの変換", () => {
  it("既定の符号: yaw 正 = 本人の左, pitch 負 = 上", () => {
    expect(subjectPose({ yaw: 20, pitch: -10, roll: 0 }, CAP.poseSign)).toEqual({ left: 20, up: 10 });
  });

  it("目標の方向への角度と、ほかの軸のずれ", () => {
    const pose = { yaw: -20, pitch: 5, roll: 0 };
    expect(poseTowards({ direction: "right", minDeg: 15, maxDeg: 30 }, pose, CAP.poseSign)).toEqual({ value: 20, offAxis: 5 });
    expect(poseTowards({ direction: "left", minDeg: 15, maxDeg: 30 }, pose, CAP.poseSign).value).toBe(-20);
    expect(poseTowards({ direction: "down", minDeg: 10, maxDeg: 25 }, pose, CAP.poseSign)).toEqual({ value: 5, offAxis: 20 });
  });

  it("符号を反転する設定で向きが入れ替わる", () => {
    expect(subjectPose({ yaw: 20, pitch: -10, roll: 0 }, { yawLeft: -1, pitchUp: 1 })).toEqual({ left: -20, up: -10 });
  });
});

describe("evaluateTarget", () => {
  it("左を向く: 範囲内なら達成、足りなければヒント", () => {
    expect(evaluateTarget(step("pose_left"), sample(0, { pose: { yaw: 20, pitch: 0, roll: 0 } }), CAP).met).toBe(true);
    const short = evaluateTarget(step("pose_left"), sample(0, { pose: { yaw: 8, pitch: 0, roll: 0 } }), CAP);
    expect(short.met).toBe(false);
    expect(short.hint).toMatch(/左/);
    expect(evaluateTarget(step("pose_left"), sample(0, { pose: { yaw: 40, pitch: 0, roll: 0 } }), CAP).hint).toMatch(/向きすぎ/);
    // 逆向きは達成しない
    expect(evaluateTarget(step("pose_left"), sample(0, { pose: { yaw: -20, pitch: 0, roll: 0 } }), CAP).met).toBe(false);
  });

  it("左を向くときに上下がずれていると達成しない", () => {
    const r = evaluateTarget(step("pose_left"), sample(0, { pose: { yaw: 20, pitch: 20, roll: 0 } }), CAP);
    expect(r.met).toBe(false);
  });

  it("笑顔: 左右の平均が min 以上で達成", () => {
    const s = step("expr_smile");
    expect(expressionValue(["mouthSmileLeft", "mouthSmileRight"], { mouthSmileLeft: 0.8, mouthSmileRight: 0.4 })).toBeCloseTo(0.6);
    expect(evaluateTarget(s, sample(0, { blendshapes: { mouthSmileLeft: 0.7, mouthSmileRight: 0.6 } }), CAP).met).toBe(true);
    expect(evaluateTarget(s, sample(0, { blendshapes: { mouthSmileLeft: 0.2, mouthSmileRight: 0.2 } }), CAP).met).toBe(false);
  });

  it("顔が無い・2 人いると達成しない", () => {
    expect(evaluateTarget(step("front"), sample(0, { faceCount: 0 }), CAP).hint).toMatch(/見えません/);
    expect(evaluateTarget(step("front"), sample(0, { faceCount: 2 }), CAP).hint).toMatch(/ほかの人/);
  });
});

describe("段階ごとの品質チェック", () => {
  it("skip した項目は一覧から消え、全体の判定にも入らない", () => {
    const r = evaluateQuality(
      { faceCount: 1, pose: { yaw: 25, pitch: 0, roll: 0 }, faceWidthPx: 500, blendshapes: {}, meanLuminance: 120, laplacianVariance: 200, cropOutsideRatio: 0 },
      FACE_CONFIG.quality,
      { skip: ["yaw"] },
    );
    expect(r.checks.some((c) => c.id === "yaw")).toBe(false);
    expect(r.status).toBe("pass");
  });

  it("左を向く段階では yaw で不合格にならない", () => {
    expect(frameQuality(step("pose_left"), sample(0, { pose: { yaw: 25, pitch: 0, roll: 0 } }), FACE_CONFIG).status).toBe("pass");
    expect(frameQuality(step("front"), sample(0, { pose: { yaw: 25, pitch: 0, roll: 0 } }), FACE_CONFIG).status).toBe("fail");
  });

  it("「あ」の段階では口が開いていても不合格にならない", () => {
    const open = sample(0, { blendshapes: { jawOpen: 0.7, eyeBlinkLeft: 0, eyeBlinkRight: 0 } });
    expect(frameQuality(step("expr_a"), open, FACE_CONFIG).status).toBe("pass");
  });
});

describe("時間の判定", () => {
  it("stats", () => {
    const s = stats([1, 2, 3, 4]);
    expect(s.mean).toBe(2.5);
    expect(s.std).toBeCloseTo(Math.sqrt(1.25));
    expect([s.min, s.max, s.count]).toEqual([1, 4, 4]);
    expect(stats([]).count).toBe(0);
  });

  it("angularSpeeds: 1 秒に 30° 回ると 30°/s", () => {
    const sp = angularSpeeds(frames(31, (i) => ({ pose: { yaw: i, pitch: 0, roll: 0 } })));
    expect(sp[0]).toBeNull();
    expect(sp[30]).toBeCloseTo(30, 0);
  });

  it("angularSpeeds: 顔が無いフレームは null", () => {
    const sp = angularSpeeds(frames(10, (i) => (i === 9 ? { pose: null, faceCount: 0 } : {})));
    expect(sp[9]).toBeNull();
  });

  it("hold: 続いた時間で進み、途切れたらリセット", () => {
    let h = updateHold({ since: null }, true, 1000);
    h = updateHold(h, true, 1500);
    expect(holdProgress(h, 1500, 1)).toBeCloseTo(0.5);
    expect(holdProgress(h, 3000, 1)).toBe(1);
    h = updateHold(h, false, 1600);
    expect(holdProgress(h, 1600, 1)).toBe(0);
  });

  it("countBlinks: 閉じて開いたら 1 回（閉じたままは数えない）", () => {
    const seq = [0.1, 0.6, 0.7, 0.2, 0.1, 0.8, 0.1, 0.9].map((v, i) =>
      sample(i * 33, { blendshapes: { eyeBlinkLeft: v, eyeBlinkRight: 0 } }),
    );
    expect(countBlinks(seq, CAP.blink)).toBe(2);
  });

  it("evaluateTemporal: 止まっていれば合格、速く動くと不合格", () => {
    const still = evaluateTemporal(step("front"), frames(30), CAP);
    expect(still.status).toBe("pass");
    expect(still.faceLostRatio).toBe(0);
    const fast = evaluateTemporal(step("front"), frames(30, (i) => ({ pose: { yaw: i * 4, pitch: 0, roll: 0 } })), CAP);
    expect(fast.checks.find((c) => c.id === "motion")?.level).toBe("fail");
  });

  it("evaluateTemporal: 顔を見失ったフレームが多いと不合格", () => {
    const r = evaluateTemporal(step("front"), frames(30, (i) => (i % 2 ? { faceCount: 0, pose: null } : {})), CAP);
    expect(r.checks.find((c) => c.id === "faceLost")?.level).toBe("fail");
  });

  it("evaluateTemporal: 明るさが大きくゆらぐと不合格", () => {
    const r = evaluateTemporal(step("front"), frames(30, (i) => ({ meanLuminance: i % 2 ? 80 : 160 })), CAP);
    expect(r.checks.find((c) => c.id === "lightFlicker")?.level).toBe("fail");
  });

  it("evaluateTemporal: free の段階は動きの速さを判定しない", () => {
    const r = evaluateTemporal(step("free"), frames(30, (i) => ({ pose: { yaw: i * 4, pitch: 0, roll: 0 } })), CAP);
    expect(r.checks.some((c) => c.id === "motion")).toBe(false);
  });
});

describe("frameScore", () => {
  it("くっきりして目が開いたフレームの方が高い", () => {
    const s = step("front");
    const good = frameScore(s, sample(0, { laplacianVariance: 300 }), 0, CAP);
    const blurry = frameScore(s, sample(0, { laplacianVariance: 20 }), 0, CAP);
    const blink = frameScore(s, sample(0, { blendshapes: { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 } }), 0, CAP);
    const moving = frameScore(s, sample(0), 40, CAP);
    expect(good).toBeGreaterThan(blurry);
    expect(good).toBeGreaterThan(blink);
    expect(good).toBeGreaterThan(moving);
  });

  it("表情の段階では表情が強いほど高い", () => {
    const s = step("expr_a");
    expect(frameScore(s, sample(0, { blendshapes: { jawOpen: 0.8 } }), 0, CAP)).toBeGreaterThan(
      frameScore(s, sample(0, { blendshapes: { jawOpen: 0.5 } }), 0, CAP),
    );
  });

  it("角度の段階では目標の中央に近いほど高い", () => {
    const s = step("pose_left");
    expect(frameScore(s, sample(0, { pose: { yaw: 22, pitch: 0, roll: 0 } }), 0, CAP)).toBeGreaterThan(
      frameScore(s, sample(0, { pose: { yaw: 16, pitch: 0, roll: 0 } }), 0, CAP),
    );
  });
});

describe("集計", () => {
  it("motionProfile: まばたきの頻度と頭の揺れ", () => {
    // 10 秒、2 秒ごとにまばたき、yaw が ±5° で揺れる
    const s = frames(300, (i) => ({
      pose: { yaw: 5 * Math.sin(i / 10), pitch: 0, roll: 0 },
      blendshapes: { eyeBlinkLeft: i % 60 < 3 ? 0.9 : 0.05, eyeBlinkRight: 0.05 },
    }));
    const p = motionProfile(s, CAP);
    expect(p.durationSec).toBeCloseTo(9.97, 1);
    expect(p.blinkPerMinute).toBeCloseTo(30, -1);
    expect(p.yaw.std).toBeGreaterThan(3);
    expect(p.blendshapes["eyeBlinkLeft"]?.max).toBeCloseTo(0.9);
  });

  it("expressionRange: 真顔の平均と表情ごとの最大値", () => {
    const neutral = frames(10, () => ({ blendshapes: { jawOpen: 0.02 } }));
    const a = frames(10, (i) => ({ blendshapes: { jawOpen: 0.1 * i } }));
    const r = expressionRange(neutral, { expr_a: a });
    expect(r.neutral["jawOpen"]).toBeCloseTo(0.02);
    expect(r.peaks["expr_a"]?.["jawOpen"]).toBeCloseTo(0.9);
  });
});

describe("timeline", async () => {
  const { decodeTimeline, encodeTimeline, sliceByTime, timelineSchema } = await import("./timeline");

  it("encode → JSON → decode で値が戻る", () => {
    const s = [
      sample(0, { blendshapes: { jawOpen: 0.12345, eyeBlinkLeft: 0.5 } }),
      sample(33.3, { metricsMeasured: false, meanLuminance: 999, laplacianVariance: 999 }),
      sample(66.7, { faceCount: 0, pose: null, blendshapes: null, center: null, faceWidthPx: null, metricsMeasured: false }),
    ];
    const tl = timelineSchema.parse(JSON.parse(JSON.stringify(encodeTimeline(s))));
    const back = decodeTimeline(tl);
    expect(back).toHaveLength(3);
    expect(back[0]!.blendshapes?.["jawOpen"]).toBeCloseTo(0.1235, 4);
    expect(back[0]!.pose).toEqual({ yaw: 0, pitch: 0, roll: 0 });
    // 測っていないフレームは直前の値を引き継ぐ（999 は保存しない）
    expect(back[1]!.meanLuminance).toBe(120);
    expect(back[1]!.metricsMeasured).toBe(false);
    expect(back[2]!.faceCount).toBe(0);
    expect(back[2]!.pose).toBeNull();
  });

  it("サーバーで動きの判定をやり直せる（同じ結果）", () => {
    const s = frames(30, (i) => ({ pose: { yaw: i * 4, pitch: 0, roll: 0 } }));
    const back = decodeTimeline(encodeTimeline(s));
    expect(evaluateTemporal(step("front"), back, CAP).status).toBe(evaluateTemporal(step("front"), s, CAP).status);
  });

  it("sliceByTime", () => {
    expect(sliceByTime(frames(30), 100, 200).map((x) => Math.round(x.t))).toEqual([100, 133, 167, 200]);
  });
});

describe("session", async () => {
  const { analyzeSession, combineLevels, evaluateRecordedStep, missingRequiredSteps } = await import("./session");

  // landmarks.json の最小限（判定に使う部分だけ本物）
  const record = (over: { yaw?: number; lap?: number; jaw?: number } = {}) =>
    ({
      detection: {
        faceCount: 1,
        pose: { yaw: over.yaw ?? 0, pitch: 0, roll: 0 },
        blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05, jawOpen: over.jaw ?? 0.02 },
      },
      metrics: { faceWidthPx: 500, meanLuminance: 120, laplacianVariance: over.lap ?? 200 },
      crop: { outsideRatio: 0 },
    }) as unknown as import("../schema").FaceRecord;

  it("combineLevels", () => {
    expect(combineLevels(["pass", "warn"])).toBe("warn");
    expect(combineLevels(["warn", "fail"])).toBe("fail");
    expect(combineLevels(["pass"])).toBe("pass");
  });

  it("よい正面は合格、目標に届かず記録した段階は注意", () => {
    const data = { step: step("front"), record: record(), samples: frames(60), hold: { fromT: 0, toT: 2000 }, belowTarget: false };
    expect(evaluateRecordedStep(data, FACE_CONFIG).level).toBe("pass");
    expect(evaluateRecordedStep({ ...data, belowTarget: true }, FACE_CONFIG).level).toBe("warn");
  });

  it("キーフレームがぶれていると不合格", () => {
    const data = { step: step("front"), record: record({ lap: 3 }), samples: frames(60), hold: { fromT: 0, toT: 2000 }, belowTarget: false };
    expect(evaluateRecordedStep(data, FACE_CONFIG).level).toBe("fail");
  });

  it("記録区間で動きすぎていると不合格（区間の外の動きは問わない）", () => {
    const s = frames(90, (i) => ({ pose: { yaw: i < 30 ? i * 5 : 0, pitch: 0, roll: 0 } }));
    const base = { step: step("front"), record: record(), samples: s, belowTarget: false };
    expect(evaluateRecordedStep({ ...base, hold: { fromT: 0, toT: 1000 } }, FACE_CONFIG).level).toBe("fail");
    expect(evaluateRecordedStep({ ...base, hold: { fromT: 1100, toT: 2900 } }, FACE_CONFIG).level).toBe("pass");
  });

  it("missingRequiredSteps: 省略できる段階は求めない", () => {
    const ids = new Set(CAP.steps.filter((s) => s.id !== "free" && s.id !== "expr_a").map((s) => s.id));
    expect(missingRequiredSteps(CAP.steps, ids).map((s) => s.id)).toEqual(["expr_a"]);
  });

  it("analyzeSession: 正面を基準に表情の幅、free から動きの特徴", () => {
    const rec = (id: string, samples: FrameSample[]) => ({
      step: step(id),
      record: record(),
      samples,
      hold: { fromT: 0, toT: 1e9 },
      belowTarget: false,
    });
    const r = analyzeSession(
      [
        rec("front", frames(30, () => ({ blendshapes: { jawOpen: 0.03 } }))),
        rec("expr_a", frames(30, (i) => ({ blendshapes: { jawOpen: i / 30 } }))),
        rec("free", frames(60)),
      ],
      FACE_CONFIG,
    );
    expect(r.expressionRange.neutral["jawOpen"]).toBeCloseTo(0.03);
    expect(r.expressionRange.peaks["expr_a"]?.["jawOpen"]).toBeCloseTo(29 / 30);
    expect(r.motionProfile?.durationSec).toBeGreaterThan(1.9);
    expect(analyzeSession([rec("front", frames(5))], FACE_CONFIG).motionProfile).toBeNull();
  });
});

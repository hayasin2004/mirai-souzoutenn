import { describe, expect, it } from "vitest";
import { FACE_CONFIG } from "./config";
import { type QualityInput, evaluateQuality, gradeMax, gradeMin, gradeRange, overallStatus } from "./quality";

const GOOD: QualityInput = {
  faceCount: 1,
  pose: { yaw: 2, pitch: -3, roll: 4 },
  faceWidthPx: 600,
  blendshapes: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.08, jawOpen: 0.02 },
  meanLuminance: 128,
  laplacianVariance: 300,
  cropOutsideRatio: 0,
};

const levelOf = (input: QualityInput, id: string) => evaluateQuality(input).checks.find((c) => c.id === id)?.level;

describe("しきい値の判定", () => {
  it("gradeMax: 境界値は合格側・注意側に入る", () => {
    const t = { pass: 10, fail: 15 };
    expect(gradeMax(10, t)).toBe("pass");
    expect(gradeMax(10.01, t)).toBe("warn");
    expect(gradeMax(15, t)).toBe("warn");
    expect(gradeMax(15.01, t)).toBe("fail");
  });

  it("gradeMin", () => {
    const t = { pass: 256, fail: 200 };
    expect(gradeMin(256, t)).toBe("pass");
    expect(gradeMin(255, t)).toBe("warn");
    expect(gradeMin(200, t)).toBe("warn");
    expect(gradeMin(199, t)).toBe("fail");
  });

  it("gradeRange", () => {
    const t = { passMin: 70, passMax: 190, failMin: 45, failMax: 220 };
    expect(gradeRange(128, t)).toBe("pass");
    expect(gradeRange(60, t)).toBe("warn");
    expect(gradeRange(200, t)).toBe("warn");
    expect(gradeRange(30, t)).toBe("fail");
    expect(gradeRange(240, t)).toBe("fail");
  });

  it("pass と fail を同じにすると注意がなくなる", () => {
    expect(gradeMax(11, { pass: 10, fail: 10 })).toBe("fail");
  });

  it("全体の判定: 不合格 > 注意 > 合格。skip は無視", () => {
    expect(overallStatus([{ level: "pass" }, { level: "skip" }])).toBe("pass");
    expect(overallStatus([{ level: "pass" }, { level: "warn" }])).toBe("warn");
    expect(overallStatus([{ level: "warn" }, { level: "fail" }])).toBe("fail");
  });
});

describe("evaluateQuality", () => {
  it("正面のよい写真はすべて合格", () => {
    const r = evaluateQuality(GOOD);
    expect(r.status).toBe("pass");
    expect(r.checks.every((c) => c.level === "pass")).toBe(true);
    expect(r.checks.every((c) => c.tip === null)).toBe(true);
  });

  it("顔がないと不合格で、ほかの項目は skip", () => {
    const r = evaluateQuality({ ...GOOD, faceCount: 0 });
    expect(r.status).toBe("fail");
    expect(r.checks.find((c) => c.id === "faceCount")?.tip).toMatch(/見つかりません/);
    expect(r.checks.filter((c) => c.id !== "faceCount").every((c) => c.level === "skip")).toBe(true);
  });

  it("顔が 2 つだと不合格", () => {
    const r = evaluateQuality({ ...GOOD, faceCount: 2 });
    expect(r.status).toBe("fail");
    expect(r.checks.find((c) => c.id === "faceCount")?.tip).toMatch(/複数/);
  });

  it("横向き: 12° は注意、20° は不合格（符号は問わない）", () => {
    expect(levelOf({ ...GOOD, pose: { yaw: 12, pitch: 0, roll: 0 } }, "yaw")).toBe("warn");
    expect(levelOf({ ...GOOD, pose: { yaw: -20, pitch: 0, roll: 0 } }, "yaw")).toBe("fail");
    expect(evaluateQuality({ ...GOOD, pose: { yaw: -20, pitch: 0, roll: 0 } }).status).toBe("fail");
  });

  it("上下の向きも判定する", () => {
    expect(levelOf({ ...GOOD, pose: { yaw: 0, pitch: -18, roll: 0 } }, "pitch")).toBe("fail");
  });

  it("roll は補正するので 20° までは合格", () => {
    expect(levelOf({ ...GOOD, pose: { yaw: 0, pitch: 0, roll: 19 } }, "roll")).toBe("pass");
    expect(levelOf({ ...GOOD, pose: { yaw: 0, pitch: 0, roll: 35 } }, "roll")).toBe("fail");
  });

  it("顔が小さいと不合格", () => {
    expect(levelOf({ ...GOOD, faceWidthPx: 150 }, "faceSize")).toBe("fail");
    expect(levelOf({ ...GOOD, faceWidthPx: 256 }, "faceSize")).toBe("pass");
  });

  it("片目でも閉じていれば判定に使う", () => {
    expect(levelOf({ ...GOOD, blendshapes: { eyeBlinkLeft: 0.02, eyeBlinkRight: 0.8, jawOpen: 0 } }, "eyesOpen")).toBe("fail");
  });

  it("口が開いていると不合格", () => {
    expect(levelOf({ ...GOOD, blendshapes: { eyeBlinkLeft: 0, eyeBlinkRight: 0, jawOpen: 0.5 } }, "mouthClosed")).toBe("fail");
  });

  it("暗い写真と明るすぎる写真で、コツの文言が変わる", () => {
    const dark = evaluateQuality({ ...GOOD, meanLuminance: 20 });
    const bright = evaluateQuality({ ...GOOD, meanLuminance: 250 });
    expect(dark.status).toBe("fail");
    expect(dark.checks.find((c) => c.id === "brightness")?.tip).toMatch(/暗く/);
    expect(bright.checks.find((c) => c.id === "brightness")?.tip).toMatch(/明るすぎ/);
  });

  it("ぶれた写真は不合格", () => {
    const r = evaluateQuality({ ...GOOD, laplacianVariance: 5 });
    expect(r.status).toBe("fail");
    expect(r.checks.find((c) => c.id === "sharpness")?.tip).toMatch(/ぶれ/);
  });

  it("はみ出しは注意止まり（既定設定）", () => {
    expect(levelOf({ ...GOOD, cropOutsideRatio: 0.3 }, "framing")).toBe("warn");
  });

  it("注意だけなら全体も注意", () => {
    expect(evaluateQuality({ ...GOOD, pose: { yaw: 12, pitch: 0, roll: 0 } }).status).toBe("warn");
  });

  it("しきい値を差し替えられる", () => {
    const strict = { ...FACE_CONFIG.quality, yawDeg: { pass: 1, fail: 1 } };
    expect(evaluateQuality(GOOD, strict).status).toBe("fail");
  });

  it("測れなかった値は skip", () => {
    expect(levelOf({ ...GOOD, laplacianVariance: null }, "sharpness")).toBe("skip");
    expect(levelOf({ ...GOOD, meanLuminance: Number.NaN }, "brightness")).toBe("skip");
  });
});

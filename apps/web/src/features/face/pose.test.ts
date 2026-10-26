import { describe, expect, it } from "vitest";
import { DEG2RAD } from "./geometry";
import { poseFromTransformMatrix } from "./pose";

type M3 = number[][];

const mul = (a: M3, b: M3): M3 =>
  a.map((row) => b[0]!.map((_, j) => row.reduce((s, v, k) => s + v * b[k]![j]!, 0)));

const rx = (t: number): M3 => [
  [1, 0, 0],
  [0, Math.cos(t), -Math.sin(t)],
  [0, Math.sin(t), Math.cos(t)],
];
const ry = (t: number): M3 => [
  [Math.cos(t), 0, Math.sin(t)],
  [0, 1, 0],
  [-Math.sin(t), 0, Math.cos(t)],
];
const rz = (t: number): M3 => [
  [Math.cos(t), -Math.sin(t), 0],
  [Math.sin(t), Math.cos(t), 0],
  [0, 0, 1],
];

/** R = Rz(roll) Ry(yaw) Rx(pitch) に平行移動とスケールを付け、列優先の 16 要素にする */
function matrix(yawDeg: number, pitchDeg: number, rollDeg: number, scale = 1): number[] {
  const r = mul(rz(rollDeg * DEG2RAD), mul(ry(yawDeg * DEG2RAD), rx(pitchDeg * DEG2RAD)));
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) out[col * 4 + row] = r[row]![col]! * scale;
  out[12] = 1.5; // 平行移動は角度に影響しない
  out[13] = -2;
  out[14] = -40;
  out[15] = 1;
  return out;
}

describe("poseFromTransformMatrix", () => {
  it("単位行列は正面（すべて 0）", () => {
    const p = poseFromTransformMatrix(matrix(0, 0, 0));
    expect(p.yaw).toBeCloseTo(0, 6);
    expect(p.pitch).toBeCloseTo(0, 6);
    expect(p.roll).toBeCloseTo(0, 6);
  });

  it.each([
    [10, 0, 0],
    [0, -12, 0],
    [0, 0, 25],
    [-30, 15, -8],
    [5, 5, 5],
  ])("yaw=%d pitch=%d roll=%d を復元できる", (yaw, pitch, roll) => {
    const p = poseFromTransformMatrix(matrix(yaw, pitch, roll));
    expect(p.yaw).toBeCloseTo(yaw, 6);
    expect(p.pitch).toBeCloseTo(pitch, 6);
    expect(p.roll).toBeCloseTo(roll, 6);
  });

  it("スケールが含まれていても角度は変わらない", () => {
    const p = poseFromTransformMatrix(matrix(-7, 9, 3, 1.8));
    expect(p.yaw).toBeCloseTo(-7, 6);
    expect(p.pitch).toBeCloseTo(9, 6);
    expect(p.roll).toBeCloseTo(3, 6);
  });

  it("要素が足りないとエラー", () => {
    expect(() => poseFromTransformMatrix([1, 0, 0])).toThrow();
  });
});

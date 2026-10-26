import { RAD2DEG } from "./geometry";

export type HeadPose = {
  /** 左右の向き（度）。y 軸まわり */
  yaw: number;
  /** 上下の向き（度）。x 軸まわり */
  pitch: number;
  /** 傾き（度）。z 軸まわり */
  roll: number;
};

/**
 * MediaPipe の facialTransformationMatrixes（4x4, 列優先の 16 要素）から顔の向きを求める。
 * 回転を R = Rz(roll) · Ry(yaw) · Rx(pitch) と分解する。
 * 正面を向いていれば 3 つとも 0 に近くなる。品質チェックでは絶対値を使う。
 */
export function poseFromTransformMatrix(data: ArrayLike<number>): HeadPose {
  if (data.length < 16) throw new Error(`4x4 行列が必要です（要素数 ${data.length}）`);
  // 列優先: R[row][col] = data[col * 4 + row]
  const r = (row: number, col: number) => data[col * 4 + row] as number;

  // スケールが含まれていても角度が崩れないよう、列ごとに正規化する
  const sx = Math.hypot(r(0, 0), r(1, 0), r(2, 0)) || 1;
  const sy = Math.hypot(r(0, 1), r(1, 1), r(2, 1)) || 1;
  const sz = Math.hypot(r(0, 2), r(1, 2), r(2, 2)) || 1;
  const r00 = r(0, 0) / sx;
  const r10 = r(1, 0) / sx;
  const r20 = r(2, 0) / sx;
  const r21 = r(2, 1) / sy;
  const r22 = r(2, 2) / sz;

  const yaw = Math.atan2(-r20, Math.hypot(r21, r22));
  const pitch = Math.atan2(r21, r22);
  const roll = Math.atan2(r10, r00);
  return { yaw: yaw * RAD2DEG, pitch: pitch * RAD2DEG, roll: roll * RAD2DEG };
}

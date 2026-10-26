import { describe, expect, it } from "vitest";
import { type FrameHeader, FrameStreamError, FrameStreamParser, encodeFrameMessage } from "./renderer-protocol";
import { pickFrame, shouldStartPlayback } from "./speech-sync";

const frame = (index: number): FrameHeader => ({
  type: "frame",
  index,
  timestampUs: index * 40000,
  durationUs: 40000,
  mime: "image/jpeg",
  width: 1024,
  height: 1024,
});

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("FrameStreamParser", () => {
  const stream = concat([
    encodeFrameMessage(frame(0), new Uint8Array([1, 2, 3])),
    encodeFrameMessage(frame(1), new Uint8Array([4, 5])),
    encodeFrameMessage({ type: "end", frames: 2 }),
  ]);

  it("まとめて渡すと全メッセージを取り出せる", () => {
    const p = new FrameStreamParser();
    const msgs = p.push(stream);
    expect(msgs.map((m) => m.header.type)).toEqual(["frame", "frame", "end"]);
    expect([...msgs[0]!.body]).toEqual([1, 2, 3]);
    expect([...msgs[1]!.body]).toEqual([4, 5]);
    expect(p.pendingBytes).toBe(0);
  });

  it("1 バイトずつ届いても同じ結果になる", () => {
    const p = new FrameStreamParser();
    const msgs = [];
    for (const b of stream) msgs.push(...p.push(new Uint8Array([b])));
    expect(msgs).toHaveLength(3);
    expect(msgs[1]!.header).toEqual(frame(1));
  });

  it("途中で切れていると残りを持ち越す", () => {
    const p = new FrameStreamParser();
    expect(p.push(stream.subarray(0, 10))).toEqual([]);
    expect(p.pendingBytes).toBe(10);
  });

  it("壊れたヘッダはエラー", () => {
    const bad = new Uint8Array([0, 0, 0, 3, 0x7b, 0x7b, 0x7b, 0, 0, 0, 0]);
    expect(() => new FrameStreamParser().push(bad)).toThrow(FrameStreamError);
    const wrongShape = encodeFrameMessage({ type: "frame" } as unknown as FrameHeader);
    expect(() => new FrameStreamParser().push(wrongShape)).toThrow(FrameStreamError);
  });

  it("長さが異常に大きいとエラー（巨大な確保をしない）", () => {
    expect(() => new FrameStreamParser().push(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow(FrameStreamError);
  });
});

describe("pickFrame", () => {
  const q = [0, 40000, 80000, 120000].map((t) => ({ timestampUs: t, durationUs: 40000 }));

  it("再生位置より前で一番新しいフレームを描き、それより前は捨てる", () => {
    expect(pickFrame(q, 90000)).toEqual({ drawIndex: 2, drop: 2 });
    expect(pickFrame(q, 0)).toEqual({ drawIndex: 0, drop: 0 });
  });

  it("まだ描く時刻でなければ -1", () => {
    expect(pickFrame([{ timestampUs: 40000, durationUs: 40000 }], 10000)).toEqual({ drawIndex: -1, drop: 0 });
    expect(pickFrame([], 10000)).toEqual({ drawIndex: -1, drop: 0 });
  });

  it("フレームが遅れているときは届いている最後のものを描く", () => {
    expect(pickFrame(q, 999999)).toEqual({ drawIndex: 3, drop: 3 });
  });
});

describe("shouldStartPlayback", () => {
  it("ためた分が足りれば始める。最後まで届いていれば短くても始める", () => {
    expect(shouldStartPlayback(100000, false, 200000)).toBe(false);
    expect(shouldStartPlayback(200000, false, 200000)).toBe(true);
    expect(shouldStartPlayback(40000, true, 200000)).toBe(true);
  });
});

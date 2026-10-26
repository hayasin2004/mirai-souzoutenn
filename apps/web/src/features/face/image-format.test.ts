import { describe, expect, it } from "vitest";
import { isJpeg, isWebm, pngSize } from "./image-format";

function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

describe("pngSize", () => {
  it("IHDR から幅と高さを読む", () => {
    expect(pngSize(pngHeader(512, 512))).toEqual({ width: 512, height: 512 });
    expect(pngSize(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("PNG でなければ null", () => {
    expect(pngSize(new Uint8Array(40))).toBeNull();
    expect(pngSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe("isJpeg", () => {
  it("SOI マーカーで判定する", () => {
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isJpeg(pngHeader(1, 1))).toBe(false);
  });
});

describe("isWebm", () => {
  it("EBML ヘッダで判定する", () => {
    expect(isWebm(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe(true);
    expect(isWebm(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { readExifDateTime } from "./exif";

/** TIFF（IFD0 → Exif IFD → DateTimeOriginal）を持つ最小の JPEG を組み立てる */
function jpegWithExif(opts: { le: boolean; original?: string; dateTime?: string }): ArrayBuffer {
  const tiff: number[] = [];
  const u16 = (v: number) => (opts.le ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v: number) =>
    opts.le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0)).concat(0);

  // ヘッダ(8) + IFD0(2 + 2*12 + 4 = 30) + ExifIFD(2 + 12 + 4 = 18) + 文字列
  const ifd0At = 8;
  const exifAt = ifd0At + 30;
  const dateTimeAt = exifAt + 18;
  const originalAt = dateTimeAt + 20;

  tiff.push(...(opts.le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0At));
  tiff.push(...u16(2));
  tiff.push(...u16(0x0132), ...u16(2), ...u32(20), ...u32(dateTimeAt));
  tiff.push(...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifAt));
  tiff.push(...u32(0));
  tiff.push(...u16(1));
  tiff.push(...u16(0x9003), ...u16(2), ...u32(20), ...u32(originalAt));
  tiff.push(...u32(0));
  tiff.push(...ascii(opts.dateTime ?? "0000:00:00 00:00:00"));
  tiff.push(...ascii(opts.original ?? "0000:00:00 00:00:00"));

  const app1 = [..."Exif"].map((c) => c.charCodeAt(0)).concat(0, 0, ...tiff);
  const len = app1.length + 2;
  const bytes = [0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...app1, 0xff, 0xda, 0, 2, 0xff, 0xd9];
  return new Uint8Array(bytes).buffer;
}

describe("readExifDateTime", () => {
  it("DateTimeOriginal を読む（リトルエンディアン）", () => {
    expect(readExifDateTime(jpegWithExif({ le: true, original: "2026:10:20 09:15:30" }))).toBe("2026-10-20T09:15:30");
  });

  it("DateTimeOriginal を読む（ビッグエンディアン）", () => {
    expect(readExifDateTime(jpegWithExif({ le: false, original: "2025:01:02 03:04:05" }))).toBe("2025-01-02T03:04:05");
  });

  it("DateTimeOriginal が空なら DateTime を使う", () => {
    expect(readExifDateTime(jpegWithExif({ le: true, dateTime: "2024:12:31 23:59:59" }))).toBe("2024-12-31T23:59:59");
  });

  it("JPEG でなければ null", () => {
    expect(readExifDateTime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBeNull();
  });

  it("EXIF が無ければ null", () => {
    expect(readExifDateTime(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]).buffer)).toBeNull();
  });
});

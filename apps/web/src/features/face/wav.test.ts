import { describe, expect, it } from "vitest";
import { WavFormatError, parseWavInfo } from "./wav";

function makeWav(opts: { sampleRate: number; channels: number; bits: number; samples: number; extraChunk?: boolean; dataSize?: number }): ArrayBuffer {
  const blockAlign = (opts.channels * opts.bits) / 8;
  const dataBytes = opts.samples * blockAlign;
  const extra = opts.extraChunk ? 8 + 5 + 1 : 0; // "LIST" 5 バイト + パディング
  const buf = new ArrayBuffer(12 + 24 + extra + 8 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, buf.byteLength - 8, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, opts.channels, true);
  v.setUint32(24, opts.sampleRate, true);
  v.setUint32(28, opts.sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, opts.bits, true);
  let o = 36;
  if (opts.extraChunk) {
    str(o, "LIST");
    v.setUint32(o + 4, 5, true);
    o += 8 + 6;
  }
  str(o, "data");
  v.setUint32(o + 4, opts.dataSize ?? dataBytes, true);
  return buf;
}

describe("parseWavInfo", () => {
  it("16bit モノラル 24kHz の長さを求める", () => {
    const info = parseWavInfo(makeWav({ sampleRate: 24000, channels: 1, bits: 16, samples: 36000 }));
    expect(info).toMatchObject({ format: 1, channels: 1, sampleRate: 24000, bitsPerSample: 16, dataBytes: 72000 });
    expect(info.durationSec).toBeCloseTo(1.5, 9);
  });

  it("ステレオ 44.1kHz", () => {
    const info = parseWavInfo(makeWav({ sampleRate: 44100, channels: 2, bits: 16, samples: 44100 }));
    expect(info.durationSec).toBeCloseTo(1, 9);
  });

  it("途中に別のチャンク（奇数長）があっても読める", () => {
    const info = parseWavInfo(makeWav({ sampleRate: 16000, channels: 1, bits: 16, samples: 8000, extraChunk: true }));
    expect(info.durationSec).toBeCloseTo(0.5, 9);
  });

  it("長さ未確定（ストリーミング）の data は残り全部", () => {
    const info = parseWavInfo(makeWav({ sampleRate: 16000, channels: 1, bits: 16, samples: 16000, dataSize: 0xffffffff }));
    expect(info.durationSec).toBeCloseTo(1, 9);
  });

  it("WAV でなければエラー", () => {
    expect(() => parseWavInfo(new ArrayBuffer(4))).toThrow(WavFormatError);
    expect(() => parseWavInfo(new TextEncoder().encode("RIFF\0\0\0\0MP3 ").buffer)).toThrow(WavFormatError);
  });
});

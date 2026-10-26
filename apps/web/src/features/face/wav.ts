/** WAV（RIFF）のヘッダから長さなどを読む純粋関数。声のサービス（PC-A）が返す音声を想定 */

export type WavInfo = {
  /** 1 = PCM, 3 = IEEE float など */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** 音声データ（data チャンク）のバイト数 */
  dataBytes: number;
  durationSec: number;
};

export class WavFormatError extends Error {}

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export function parseWavInfo(buf: ArrayBuffer): WavInfo {
  const view = new DataView(buf);
  if (view.byteLength < 12 || fourCC(view, 0) !== "RIFF" || fourCC(view, 8) !== "WAVE") {
    throw new WavFormatError("WAV（RIFF/WAVE）ではありません");
  }

  let fmt: Omit<WavInfo, "dataBytes" | "durationSec"> | null = null;
  let blockAlign = 0;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > view.byteLength) throw new WavFormatError("fmt チャンクが壊れています");
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
      blockAlign = view.getUint16(body + 12, true);
    } else if (id === "data") {
      if (!fmt) throw new WavFormatError("fmt チャンクより前に data チャンクがあります");
      if (fmt.sampleRate === 0 || blockAlign === 0) throw new WavFormatError("サンプリング周波数が不正です");
      // ストリーミングで長さが未確定（0 / 0xFFFFFFFF）のときは残り全部をデータとみなす
      const remaining = view.byteLength - body;
      const dataBytes = size === 0 || size === 0xffffffff || size > remaining ? remaining : size;
      return { ...fmt, dataBytes, durationSec: dataBytes / blockAlign / fmt.sampleRate };
    }
    offset = body + size + (size % 2); // チャンクは偶数バイト境界
  }
  throw new WavFormatError("data チャンクがありません");
}

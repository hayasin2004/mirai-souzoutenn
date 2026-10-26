/**
 * JPEG の EXIF から撮影日時（DateTimeOriginal、無ければ DateTime）を読む最小限のパーサ。
 * 返り値は "YYYY-MM-DDTHH:MM:SS"（タイムゾーンなし。カメラの現地時刻）。読めなければ null。
 */
export function readExifDateTime(buf: ArrayBuffer): string | null {
  const view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) return null;
    const size = view.getUint16(offset + 2);
    if (marker === 0xffe1 && size >= 8 && readAscii(view, offset + 4, 6) === "Exif\0\0") {
      return parseTiff(view, offset + 10, Math.min(view.byteLength, offset + 2 + size));
    }
    if (marker === 0xffda) return null; // 画像データの開始。ここより後に EXIF は無い
    offset += 2 + size;
  }
  return null;
}

const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;

function parseTiff(view: DataView, start: number, end: number): string | null {
  if (start + 8 > end) return null;
  const order = view.getUint16(start);
  const le = order === 0x4949; // "II"
  if (!le && order !== 0x4d4d) return null;
  const u16 = (o: number) => view.getUint16(start + o, le);
  const u32 = (o: number) => view.getUint32(start + o, le);

  const readIfd = (ifdOffset: number): Map<number, { type: number; count: number; valueOffset: number }> => {
    const tags = new Map<number, { type: number; count: number; valueOffset: number }>();
    if (start + ifdOffset + 2 > end) return tags;
    const n = u16(ifdOffset);
    for (let i = 0; i < n; i++) {
      const e = ifdOffset + 2 + i * 12;
      if (start + e + 12 > end) break;
      tags.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valueOffset: e + 8 });
    }
    return tags;
  };

  const readDate = (tag: { type: number; count: number; valueOffset: number } | undefined): string | null => {
    if (!tag || tag.type !== 2 || tag.count < 19) return null; // ASCII "YYYY:MM:DD HH:MM:SS\0"
    const at = tag.count > 4 ? u32(tag.valueOffset) : tag.valueOffset;
    if (start + at + 19 > end) return null;
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(readAscii(view, start + at, 19));
    if (!m || m[1] === "0000") return null;
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  };

  const ifd0 = readIfd(u32(4));
  const exifPtr = ifd0.get(TAG_EXIF_IFD);
  if (exifPtr) {
    const original = readDate(readIfd(u32(exifPtr.valueOffset)).get(TAG_DATETIME_ORIGINAL));
    if (original) return original;
  }
  return readDate(ifd0.get(TAG_DATETIME));
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length && offset + i < view.byteLength; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

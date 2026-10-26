import { FACE_CONFIG } from "../config";

/** 肩から上の画像（背景を切り抜いたもの）のプレビュー。顔を動かす処理の元画像になる */
export function BustPreview({ url, personCoverage }: { url: string; personCoverage: number }) {
  const { outputWidth: w, outputHeight: h, minPersonCoverage } = FACE_CONFIG.bust;
  const lowCoverage = personCoverage < minPersonCoverage;
  return (
    <figure className="space-y-1">
      <figcaption className="label">
        BUST · {w}×{h}（動かす元の画像）
      </figcaption>
      <div className="border border-line bg-black" style={{ aspectRatio: `${w} / ${h}` }}>
        <img src={url} alt="肩から上の切り抜き" className="block size-full" />
      </div>
      <p className={`font-mono text-[11px] ${lowCoverage ? "text-warn" : "text-ink-dim"}`}>
        人物 {(personCoverage * 100).toFixed(0)}%
        {lowCoverage && " — 切り抜きがうまくいっていない可能性があります（背景が人物に近い色など）"}
      </p>
    </figure>
  );
}

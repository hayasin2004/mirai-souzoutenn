"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ACCEPTED_TYPES, type PhotoAnalysis, PhotoAnalysisError, analyzePhoto, toFaceRecord } from "../analyze";
import { BustPreview } from "./BustPreview";
import { QualityReportView } from "./QualityReportView";

type State =
  | { kind: "idle" }
  | { kind: "analyzing"; fileName: string }
  | { kind: "result"; analysis: PhotoAnalysis; originalUrl: string; faceUrl: string | null; bustUrl: string | null }
  | { kind: "error"; message: string };

export function FaceUploader({ personId }: { personId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [warnAcknowledged, setWarnAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // プレビュー用の URL を片付ける
  useEffect(() => {
    if (state.kind !== "result") return;
    return () => {
      URL.revokeObjectURL(state.originalUrl);
      if (state.faceUrl) URL.revokeObjectURL(state.faceUrl);
      if (state.bustUrl) URL.revokeObjectURL(state.bustUrl);
    };
  }, [state]);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setSaveMessage(null);
    setWarnAcknowledged(false);
    setState({ kind: "analyzing", fileName: file.name });
    try {
      const analysis = await analyzePhoto(file);
      setState({
        kind: "result",
        analysis,
        originalUrl: URL.createObjectURL(analysis.originalJpeg),
        faceUrl: analysis.facePng ? URL.createObjectURL(analysis.facePng) : null,
        bustUrl: analysis.bust ? URL.createObjectURL(analysis.bust.cutoutPng) : null,
      });
    } catch (err) {
      console.error(err);
      setState({
        kind: "error",
        message: err instanceof PhotoAnalysisError ? err.message : "顔の解析に失敗しました。別の写真で試してください",
      });
    }
  }

  async function save() {
    if (state.kind !== "result") return;
    const { analysis } = state;
    const record = toFaceRecord(analysis);
    if (!record || !analysis.facePng) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const form = new FormData();
      form.append("original", analysis.originalJpeg, "original.jpg");
      form.append("face", analysis.facePng, "face.png");
      form.append("record", JSON.stringify(record));
      if (analysis.bust) {
        form.append("bust", analysis.bust.bustPng, "bust.png");
        form.append("bustCutout", analysis.bust.cutoutPng, "bust_cutout.png");
      }
      const res = await fetch(`/api/persons/${personId}/face`, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setSaveMessage({ ok: false, text: body.error ?? `保存に失敗しました（${res.status}）` });
        return;
      }
      setSaveMessage({ ok: true, text: "保存しました。この写真が使用中になりました。" });
      setState({ kind: "idle" });
      router.refresh();
    } catch {
      setSaveMessage({ ok: false, text: "保存に失敗しました。サーバーが動いているか確認してください" });
    } finally {
      setSaving(false);
    }
  }

  const result = state.kind === "result" ? state : null;
  const status = result?.analysis.quality.status;
  const canSave = !!result?.analysis.facePng && status !== "fail" && (status === "pass" || warnAcknowledged) && !saving;

  return (
    <div className="space-y-6">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFile(e.dataTransfer.files[0]);
        }}
        className={`panel flex cursor-pointer flex-col items-center justify-center gap-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging ? "border-holo bg-holo/5" : "hover:border-line-strong"
        }`}
      >
        <p className="label">DROP PHOTO</p>
        <p>顔写真をここにドラッグ＆ドロップ、またはクリックして選択</p>
        <p className="text-xs text-ink-dim">JPEG・PNG ／ 正面・明るい場所・頭の上から首まで写った写真</p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          className="hidden"
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>

      {state.kind === "analyzing" && (
        <p className="font-mono text-sm text-holo">ANALYZING… {state.fileName}</p>
      )}
      {state.kind === "error" && <p className="text-sm text-ng">{state.message}</p>}
      {saveMessage && <p className={`text-sm ${saveMessage.ok ? "text-ok" : "text-ng"}`}>{saveMessage.text}</p>}

      {result && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <figure className="space-y-1">
                <figcaption className="label">SOURCE · {result.analysis.width}×{result.analysis.height}</figcaption>
                <SourcePreview analysis={result.analysis} url={result.originalUrl} />
              </figure>
              <figure className="space-y-1">
                <figcaption className="label">CROP · 512×512</figcaption>
                {result.faceUrl && result.analysis.face ? (
                  <CropPreview analysis={result.analysis} url={result.faceUrl} />
                ) : (
                  <div className="flex aspect-square items-center justify-center border border-line text-xs text-ink-dim">
                    切り出せません
                  </div>
                )}
              </figure>
            </div>
            {result.bustUrl && result.analysis.bust && (
              <div className="max-w-xs">
                <BustPreview url={result.bustUrl} personCoverage={result.analysis.bust.personCoverage} />
              </div>
            )}
            {result.analysis.face && (
              <dl className="grid grid-cols-3 gap-2 font-mono text-xs">
                {(["yaw", "pitch", "roll"] as const).map((k) => (
                  <div key={k} className="panel px-3 py-2">
                    <dt className="label">{k}</dt>
                    <dd>{result.analysis.face!.pose[k].toFixed(1)}°</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>

          <div className="panel space-y-5 p-5">
            <QualityReportView report={result.analysis.quality} />
            {status === "warn" && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-warn"
                  checked={warnAcknowledged}
                  onChange={(e) => setWarnAcknowledged(e.target.checked)}
                />
                注意の項目を確認したうえで、この写真を保存する
              </label>
            )}
            <div className="flex gap-3">
              <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => void save()}>
                {saving ? "保存中…" : "保存して使用中にする"}
              </button>
              <button type="button" className="btn" disabled={saving} onClick={() => setState({ kind: "idle" })}>
                やり直す
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SourcePreview({ analysis, url }: { analysis: PhotoAnalysis; url: string }) {
  const { width, height, face } = analysis;
  const b = face?.boundingBox;
  const stroke = Math.max(width, height) / 300;
  return (
    <div className="relative border border-line bg-black">
      <img src={url} alt="取り込んだ写真" className="block h-auto w-full" />
      {b && (
        <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 size-full">
          <rect x={b.x} y={b.y} width={b.width} height={b.height} fill="none" stroke="#7fe3ff" strokeWidth={stroke} />
        </svg>
      )}
    </div>
  );
}

function CropPreview({ analysis, url }: { analysis: PhotoAnalysis; url: string }) {
  const crop = analysis.face!.crop;
  const s = crop.outputSize;
  return (
    <div className="relative border border-line bg-black">
      <img src={url} alt="切り出した顔" className="block aspect-square w-full" />
      <svg viewBox={`0 0 ${s} ${s}`} className="absolute inset-0 size-full">
        {crop.landmarks.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={1.1} fill="#7fe3ff" opacity={0.7} />
        ))}
        <line x1={s / 2} y1={0} x2={s / 2} y2={s} stroke="#7fe3ff" strokeOpacity={0.25} strokeDasharray="4 4" />
        <line x1={0} y1={s / 2} x2={s} y2={s / 2} stroke="#7fe3ff" strokeOpacity={0.25} strokeDasharray="4 4" />
      </svg>
    </div>
  );
}

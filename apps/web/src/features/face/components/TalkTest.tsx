"use client";

import { useRef, useState } from "react";
import { RENDERER_CONFIG, type RendererKind, createFaceRenderer } from "../renderer-config";
import type { FaceRenderer } from "../renderer";
import { type PlaySpeechResult, playSpeech } from "../speech-player";
import { WavFormatError, parseWavInfo } from "../wav";
import { FaceDisplay, type FaceDisplayHandle } from "./FaceDisplay";

const KINDS: { kind: RendererKind; label: string; note: string }[] = [
  { kind: "static", label: "静止画", note: "PC-A なし。音声に合わせて静止画を流す" },
  { kind: "mock", label: "試験サーバー", note: "Next 内の試験用（口は動かない）。通信と同期の確認用" },
  {
    kind: "remote",
    label: "PC-A",
    note: RENDERER_CONFIG.remoteUrl ? `NEXT_PUBLIC_FACE_RENDERER_URL = ${RENDERER_CONFIG.remoteUrl}` : "NEXT_PUBLIC_FACE_RENDERER_URL が未設定",
  },
];

/** wav を入れて、顔を動かす処理を通しで試すページ */
export function TalkTest({ personId, name }: { personId: string; name: string }) {
  const displayRef = useRef<FaceDisplayHandle>(null);
  const rendererRef = useRef<{ kind: RendererKind; assetId: string; renderer: FaceRenderer } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [kind, setKind] = useState<RendererKind>("mock");
  const [wav, setWav] = useState<{ name: string; data: ArrayBuffer; durationSec: number } | null>(null);
  const [status, setStatus] = useState<string>("");
  const [result, setResult] = useState<(PlaySpeechResult & { renderer: string }) | null>(null);
  const [playing, setPlaying] = useState(false);

  async function loadWav(file: File | undefined) {
    if (!file) return;
    const data = await file.arrayBuffer();
    try {
      setWav({ name: file.name, data, durationSec: parseWavInfo(data).durationSec });
      setStatus("");
    } catch (err) {
      setWav(null);
      setStatus(err instanceof WavFormatError ? `WAV を選んでください（${err.message}）` : "音声を読めません");
    }
  }

  async function play() {
    const display = displayRef.current;
    const asset = display?.asset;
    const canvas = display?.speechCanvas;
    if (!wav || !display || !asset || !canvas) return;
    setPlaying(true);
    setResult(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      // レンダラーは種類と顔が変わったときだけ作り直す（prepare は重い）
      let r = rendererRef.current;
      if (!r || r.kind !== kind || r.assetId !== asset.assetId) {
        r?.renderer.dispose();
        setStatus("準備中…");
        const created = await createFaceRenderer(kind);
        await created.renderer.prepare(asset, { signal: ac.signal });
        r = { kind, assetId: asset.assetId, renderer: created.renderer };
        rendererRef.current = r;
        if (created.note) setStatus(created.note);
      }
      setStatus((s) => (s === "準備中…" ? "" : s));
      const stats = await playSpeech({
        renderer: r.renderer,
        audio: { mimeType: "audio/wav", data: wav.data },
        canvas,
        signal: ac.signal,
        onStart: () => display.setSpeaking(true),
      });
      setResult({ ...stats, renderer: r.renderer.kind });
    } catch (err) {
      if (!ac.signal.aborted) {
        console.error(err);
        setStatus(err instanceof Error ? err.message : "再生に失敗しました");
      }
    } finally {
      display.setSpeaking(false);
      setPlaying(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-2">
        <FaceDisplay ref={displayRef} personId={personId} />
        <p className="text-center text-sm text-ink-dim">{name}</p>
      </div>

      <div className="panel space-y-5 p-5">
        <fieldset className="space-y-2">
          <legend className="label mb-1">RENDERER</legend>
          {KINDS.map((k) => (
            <label key={k.kind} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="kind"
                className="mt-1 accent-holo"
                checked={kind === k.kind}
                disabled={playing}
                onChange={() => setKind(k.kind)}
              />
              <span>
                {k.label}
                <span className="block text-xs text-ink-dim">{k.note}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="block space-y-1 text-sm">
          <span className="label">VOICE (WAV)</span>
          <input type="file" accept="audio/wav,.wav" className="block text-sm" disabled={playing} onChange={(e) => void loadWav(e.target.files?.[0])} />
          {wav && (
            <span className="font-mono text-xs text-ink-dim">
              {wav.name} · {wav.durationSec.toFixed(2)} 秒
            </span>
          )}
        </label>

        <div className="flex gap-2">
          <button type="button" className="btn btn-primary" disabled={!wav || playing} onClick={() => void play()}>
            {playing ? "再生中…" : "しゃべらせる"}
          </button>
          <button type="button" className="btn" disabled={!playing} onClick={() => abortRef.current?.abort()}>
            止める
          </button>
        </div>

        {status && <p className="text-sm text-warn">{status}</p>}
        {result && (
          <dl className="grid grid-cols-2 gap-y-1 font-mono text-xs">
            <dt className="text-ink-dim">レンダラー</dt>
            <dd>{result.renderer}</dd>
            <dt className="text-ink-dim">鳴り始めまで</dt>
            <dd>{result.startLatencyMs.toFixed(0)} ms</dd>
            <dt className="text-ink-dim">描いたフレーム</dt>
            <dd>{result.drawn}</dd>
            <dt className="text-ink-dim">捨てたフレーム</dt>
            <dd>{result.dropped}</dd>
            <dt className="text-ink-dim">映像が止まった回数</dt>
            <dd>{result.starved}</dd>
          </dl>
        )}
      </div>
    </div>
  );
}

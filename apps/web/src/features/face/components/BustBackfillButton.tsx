"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { renderBust, toBustRecord } from "../bust-render";
import { faceRecordSchema } from "../schema";

/**
 * 肩から上の画像が無い（この機能より前に保存した）顔に、保存済みの元画像とランドマークから作って足す。
 */
export function BustBackfillButton({ assetId }: { assetId: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });

  async function run() {
    setState({ busy: true, message: null });
    try {
      const [original, landmarks] = await Promise.all([
        fetch(`/api/face-assets/${assetId}/original.jpg`, { cache: "no-store" }),
        fetch(`/api/face-assets/${assetId}/landmarks.json`, { cache: "no-store" }),
      ]);
      if (!original.ok || !landmarks.ok) throw new Error("保存済みのデータを読めません");
      const record = faceRecordSchema.parse(await landmarks.json());
      const bitmap = await createImageBitmap(await original.blob());
      const bust = await renderBust(
        bitmap,
        bitmap.width,
        bitmap.height,
        record.detection.landmarks.map(([x, y, z]) => ({ x, y, z })),
      );
      bitmap.close();
      const form = new FormData();
      form.append("bust", JSON.stringify(toBustRecord(bust)));
      form.append("bustPng", bust.bustPng, "bust.png");
      form.append("bustCutoutPng", bust.cutoutPng, "bust_cutout.png");
      const res = await fetch(`/api/face-assets/${assetId}/bust`, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `失敗しました（${res.status}）`);
      setState({ busy: false, message: null });
      router.refresh();
    } catch (err) {
      setState({ busy: false, message: err instanceof Error ? err.message : "失敗しました" });
    }
  }

  return (
    <span className="flex flex-col gap-1">
      <button type="button" className="btn px-2 py-1 text-xs" disabled={state.busy} onClick={() => void run()}>
        {state.busy ? "作成中…" : "肩から上を作る"}
      </button>
      {state.message && <span className="text-xs text-ng">{state.message}</span>}
    </span>
  );
}

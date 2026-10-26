"use client";

import { useActionState, useState, useTransition } from "react";
import {
  type ActionState,
  activateAssetAction,
  createPersonAction,
  deletePersonAction,
  setConsentAction,
  setStageSubjectAction,
} from "../persons/actions";

export function CreatePersonForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createPersonAction, { error: null });
  return (
    <form action={action} className="panel flex flex-wrap items-end gap-4 p-5">
      <label className="flex flex-col gap-1">
        <span className="label">NAME</span>
        <input name="name" required maxLength={64} className="input w-64" placeholder="名前" />
      </label>
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input type="checkbox" name="consent" className="accent-holo" />
        本人の同意を得た（同意書を受け取った）
      </label>
      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "登録中…" : "人物を登録"}
      </button>
      {state.error && <p className="w-full text-sm text-ng">{state.error}</p>}
    </form>
  );
}

export function ConsentToggle({ personId, consentAt }: { personId: string; consentAt: Date | null }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);

  if (!consentAt) {
    return (
      <button
        type="button"
        disabled={pending}
        className="btn"
        onClick={() => start(() => setConsentAction(personId, true))}
      >
        同意を記録する
      </button>
    );
  }
  if (!confirming) {
    return (
      <button type="button" className="btn" onClick={() => setConfirming(true)}>
        同意を取り消す
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-warn">取り消すと展示画面に表示されず、写真も取り込めなくなります。</span>
      <button
        type="button"
        disabled={pending}
        className="btn btn-danger"
        onClick={() => start(() => setConsentAction(personId, false))}
      >
        取り消す
      </button>
      <button type="button" className="btn" onClick={() => setConfirming(false)}>
        やめる
      </button>
    </span>
  );
}

export function DeletePersonButton({
  personId,
  name,
  redirectTo,
}: {
  personId: string;
  name: string;
  redirectTo?: string;
}) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
        完全に削除
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-ng">「{name}」の人物情報・顔写真・ランドマークをすべて削除します。元に戻せません。</span>
      <button
        type="button"
        disabled={pending}
        className="btn btn-danger"
        onClick={() => start(() => deletePersonAction(personId, redirectTo))}
      >
        {pending ? "削除中…" : "削除する"}
      </button>
      <button type="button" disabled={pending} className="btn" onClick={() => setConfirming(false)}>
        やめる
      </button>
    </span>
  );
}

export function ActivateAssetButton({ personId, assetId }: { personId: string; assetId: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className="btn text-xs"
      onClick={() => start(() => activateAssetAction(personId, assetId))}
    >
      {pending ? "切替中…" : "この写真を使う"}
    </button>
  );
}

export function StageSubjectButton({ personId, isStageSubject }: { personId: string; isStageSubject: boolean }) {
  const [pending, start] = useTransition();
  if (isStageSubject) return <span className="font-mono text-xs text-holo">● 展示中</span>;
  return (
    <button type="button" disabled={pending} className="btn" onClick={() => start(() => setStageSubjectAction(personId))}>
      展示に使う
    </button>
  );
}

export function ImportTabs({ camera, photo }: { camera: React.ReactNode; photo: React.ReactNode }) {
  const [tab, setTab] = useState<"camera" | "photo">("camera");
  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-1 border-b border-line">
        {(
          [
            ["camera", "カメラで撮影"],
            ["photo", "写真ファイルから"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b px-4 py-2 text-sm ${tab === key ? "border-holo text-holo" : "border-transparent text-ink-dim hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {/* 撮影中の状態を保つため、切り替えても消さずに隠す */}
      <div hidden={tab !== "camera"}>{camera}</div>
      <div hidden={tab !== "photo"}>{photo}</div>
    </div>
  );
}

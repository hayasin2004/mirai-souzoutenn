import { connection } from "next/server";
import { TalkTest } from "@/features/face/components/TalkTest";
import { listPersons } from "@/features/face/server/repository";

/** 顔を動かす処理の通し確認（wav → 顔の映像＋音声） */
export default async function TalkTestPage() {
  await connection();
  const candidates = listPersons().filter((p) => p.consentAt && p.activeAsset);
  const person = candidates.find((p) => p.isStageSubject) ?? candidates[0] ?? null;

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-xl font-light">しゃべる顔の確認</h1>
        <p className="mt-1 text-sm text-ink-dim">
          声のサービスが作った WAV を入れて、顔を動かす処理（静止画・試験サーバー・PC-A）を通しで確認します。
        </p>
      </div>
      {person ? (
        <TalkTest personId={person.id} name={person.name} />
      ) : (
        <p className="text-sm text-ink-dim">展示に使う人物（同意と使用中の顔がある人）がいません。</p>
      )}
    </main>
  );
}

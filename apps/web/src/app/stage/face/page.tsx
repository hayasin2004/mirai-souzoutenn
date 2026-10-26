import Link from "next/link";
import { connection } from "next/server";
import { FaceDisplay } from "@/features/face/components/FaceDisplay";
import { listPersons } from "@/features/face/server/repository";

export default async function StageFacePage() {
  await connection();
  // 展示に使う人物（管理画面の「展示に使う」）。未設定なら、同意と使用中の顔がある最初の人物
  const candidates = listPersons().filter((p) => p.consentAt && p.activeAsset);
  const person = candidates.find((p) => p.isStageSubject) ?? candidates[0] ?? null;

  return (
    <main className="flex min-h-dvh flex-col px-6 py-5">
      <header className="flex items-center justify-between">
        <p className="label">MEMORY ARCHIVE TERMINAL · 2126 · FACE CHANNEL</p>
        <Link href="/admin/persons" className="label hover:text-holo">
          ADMIN
        </Link>
      </header>

      {person ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-8">
          <div className="relative w-[min(78vh,90vw)]">
            <Corners />
            <FaceDisplay personId={person.id} />
          </div>
          <div className="text-center">
            <p className="label">ARCHIVE SUBJECT</p>
            <p className="mt-1 text-2xl font-light tracking-wider">{person.name}</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="label">NO ARCHIVED FACE — 管理画面で顔を登録してください</p>
        </div>
      )}
    </main>
  );
}

/** 四隅の細い枠線 */
function Corners() {
  const base = "pointer-events-none absolute size-6 border-holo/50";
  return (
    <>
      <span className={`${base} -top-3 -left-3 border-t border-l`} />
      <span className={`${base} -top-3 -right-3 border-t border-r`} />
      <span className={`${base} -bottom-3 -left-3 border-b border-l`} />
      <span className={`${base} -right-3 -bottom-3 border-r border-b`} />
    </>
  );
}

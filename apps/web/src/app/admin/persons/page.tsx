import Link from "next/link";
import { connection } from "next/server";
import { listPersons } from "@/features/face/server/repository";
import { ConsentToggle, CreatePersonForm, DeletePersonButton, StageSubjectButton } from "../_components/PersonControls";
import { formatDateTime } from "../_components/format";

export default async function PersonsPage() {
  await connection(); // DB を毎回読む（ビルド時に固定しない）
  const persons = listPersons();

  return (
    <main className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-xl font-light">人物</h1>
        <CreatePersonForm />
      </section>

      <section className="space-y-3">
        <p className="label">REGISTERED · {persons.length.toString().padStart(3, "0")}</p>
        {persons.length === 0 && <p className="text-sm text-ink-dim">まだ登録されていません。</p>}
        <ul className="space-y-3">
          {persons.map((p) => (
            <li key={p.id} className="panel flex flex-wrap items-center gap-5 p-4">
              <div className="size-20 shrink-0 overflow-hidden rounded-sm border border-line bg-black">
                {p.activeAsset && (
                  <img src={`/api/face-assets/${p.activeAsset.id}/face.png`} alt="" className="size-full object-cover" />
                )}
              </div>
              <div className="min-w-48 flex-1 space-y-1">
                <p className="text-lg">{p.name}</p>
                <p className="font-mono text-xs text-ink-dim">
                  {p.consentAt ? (
                    <span className="text-ok">同意 {formatDateTime(p.consentAt)}</span>
                  ) : (
                    <span className="text-warn">同意なし</span>
                  )}
                  <span className="mx-2">·</span>写真 {p.assetCount} 枚
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/admin/persons/${p.id}/face`} className="btn btn-primary">
                  顔データ
                </Link>
                {p.consentAt && p.activeAsset && <StageSubjectButton personId={p.id} isStageSubject={p.isStageSubject} />}
                <ConsentToggle personId={p.id} consentAt={p.consentAt} />
                <DeletePersonButton personId={p.id} name={p.name} />
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

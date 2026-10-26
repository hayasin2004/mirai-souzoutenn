import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { BustBackfillButton } from "@/features/face/components/BustBackfillButton";
import { CaptureStudio } from "@/features/face/components/CaptureStudio";
import { FaceUploader } from "@/features/face/components/FaceUploader";
import { LevelBadge } from "@/features/face/components/QualityReportView";
import { getPerson, listAssets, listCaptureSessions, readSessionRecord } from "@/features/face/server/repository";
import { ID_PATTERN } from "@/lib/paths";
import { ActivateAssetButton, ConsentToggle, DeletePersonButton, ImportTabs } from "../../../_components/PersonControls";
import { formatDateTime } from "../../../_components/format";

export default async function PersonFacePage({ params }: { params: Promise<{ personId: string }> }) {
  await connection();
  const { personId } = await params;
  if (!ID_PATTERN.test(personId)) notFound();
  const person = getPerson(personId);
  if (!person) notFound();
  const assets = listAssets(personId);
  const sessions = await Promise.all(
    listCaptureSessions(personId).map(async (session) => ({ session, record: await readSessionRecord(session) })),
  );

  return (
    <main className="space-y-10">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/admin/persons" className="text-sm text-ink-dim hover:text-holo">
            ← 人物一覧
          </Link>
          <h1 className="mt-2 text-2xl font-light">{person.name}</h1>
          <p className="mt-1 font-mono text-xs text-ink-dim">ID {person.id}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ConsentToggle personId={person.id} consentAt={person.consentAt} />
          <DeletePersonButton personId={person.id} name={person.name} redirectTo="/admin/persons" />
        </div>
      </section>

      <section className="space-y-3">
        <p className="label">IMPORT FACE</p>
        {person.consentAt ? (
          <ImportTabs camera={<CaptureStudio personId={person.id} />} photo={<FaceUploader personId={person.id} />} />
        ) : (
          <div className="panel space-y-2 border-warn/40 p-5">
            <p className="text-warn">本人の同意が記録されていないため、顔写真を取り込めません。</p>
            <p className="text-sm text-ink-dim">同意書を受け取ってから「同意を記録する」を押してください。</p>
          </div>
        )}
      </section>

      {sessions.length > 0 && (
        <section className="space-y-3">
          <p className="label">CAPTURE SESSIONS · {sessions.length.toString().padStart(3, "0")}</p>
          <ul className="space-y-3">
            {sessions.map(({ session, record }) => (
              <li key={session.id} className="panel space-y-3 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <LevelBadge level={session.qualityStatus} />
                  <span className="font-mono text-xs text-ink-dim">{formatDateTime(session.createdAt)}</span>
                  <span className="font-mono text-xs text-ink-dim">
                    {session.recordedSteps} 段階{session.hasVideo && " · 動画あり"}
                  </span>
                  {record?.motionProfile && (
                    <span className="font-mono text-xs text-ink-dim">
                      まばたき {record.motionProfile.blinkPerMinute.toFixed(1)} 回/分
                    </span>
                  )}
                  <a href={`/api/captures/${session.id}/session.json`} className="ml-auto text-xs text-ink-dim hover:text-holo">
                    session.json
                  </a>
                </div>
                <ul className="flex flex-wrap gap-2">
                  {record?.steps
                    .filter((s) => s.status === "recorded")
                    .map((s) => (
                      <li key={s.id} className="w-20 space-y-1">
                        <a href={s.hasVideo ? `/api/captures/${session.id}/${s.id}/clip.webm` : undefined} title={s.hasVideo ? "動画を開く" : undefined}>
                          <img src={`/api/captures/${session.id}/${s.id}/face.png`} alt={s.label} className="aspect-square w-full bg-black" />
                        </a>
                        <p className="truncate text-[11px] text-ink-dim">{s.label}</p>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <p className="label">ARCHIVED FACES · {assets.length.toString().padStart(3, "0")}</p>
        {assets.length === 0 && <p className="text-sm text-ink-dim">保存された顔写真はありません。</p>}
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {assets.map((a) => (
            <li key={a.id} className={`panel space-y-2 p-2 ${a.isActive ? "border-holo" : ""}`}>
              <img src={`/api/face-assets/${a.id}/face.png`} alt="" className="aspect-square w-full bg-black" />
              <div className="flex items-center justify-between gap-2">
                <LevelBadge level={a.qualityStatus} />
                <span className="font-mono text-[11px] text-ink-dim">{formatDateTime(a.createdAt)}</span>
              </div>
              {a.isActive ? (
                <p className="font-mono text-xs text-holo">● 使用中</p>
              ) : (
                <ActivateAssetButton personId={person.id} assetId={a.id} />
              )}
              {a.bustCutoutPath ? (
                <a href={`/api/face-assets/${a.id}/bust_cutout.png`} className="block text-xs text-ink-dim hover:text-holo">
                  肩から上 ✓
                </a>
              ) : (
                person.consentAt && <BustBackfillButton assetId={a.id} />
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

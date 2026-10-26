import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  type AvatarAsset,
  type CaptureSession,
  type Person,
  type StoredQualityStatus,
  avatarAssets,
  captureSessions,
  persons,
} from "@/db/schema";
import { faceAssetRelDir, personDir, resolveDataPath } from "@/lib/paths";
import { type SessionRecord, sessionRecordSchema } from "../capture/session-schema";

export const FACE_FILES = {
  original: "original.jpg",
  face: "face.png",
  landmarks: "landmarks.json",
  /** 肩から上（背景つき）と、背景を透明にしたもの。顔を動かす処理の元画像 */
  bust: "bust.png",
  bustCutout: "bust_cutout.png",
} as const;

export type BustFiles = { bustPng: Uint8Array; cutoutPng: Uint8Array };

/** カメラ撮影の各段階のフォルダに入るファイル */
export const STEP_FILES = {
  ...FACE_FILES,
  timeline: "timeline.json",
  video: "clip.webm",
} as const;

export const SESSION_FILE = "session.json";

export class NotFoundError extends Error {}
export class ConsentRequiredError extends Error {}

export type PersonSummary = Person & { activeAsset: AvatarAsset | null; assetCount: number };

export function listPersons(): PersonSummary[] {
  const db = getDb();
  const all = db.select().from(persons).orderBy(persons.createdAt).all();
  const assets = db.select().from(avatarAssets).all();
  return all.map((p) => {
    const mine = assets.filter((a) => a.personId === p.id);
    return { ...p, activeAsset: mine.find((a) => a.isActive) ?? null, assetCount: mine.length };
  });
}

export function getPerson(personId: string): Person | null {
  return getDb().select().from(persons).where(eq(persons.id, personId)).get() ?? null;
}

export function createPerson(name: string, consented: boolean): Person {
  return getDb()
    .insert(persons)
    .values({ id: crypto.randomUUID(), name, consentAt: consented ? new Date() : null })
    .returning()
    .get();
}

export function getStageSubject(): Person | null {
  return getDb().select().from(persons).where(eq(persons.isStageSubject, true)).get() ?? null;
}

/** 展示画面に出す人物を 1 人だけ選ぶ */
export function setStageSubject(personId: string): void {
  getDb().transaction((tx) => {
    const target = tx.select().from(persons).where(eq(persons.id, personId)).get();
    if (!target) throw new NotFoundError("人物が見つかりません");
    tx.update(persons).set({ isStageSubject: false }).where(eq(persons.isStageSubject, true)).run();
    tx.update(persons).set({ isStageSubject: true }).where(eq(persons.id, personId)).run();
  });
}

export function setConsent(personId: string, consented: boolean): void {
  const r = getDb()
    .update(persons)
    .set({ consentAt: consented ? new Date() : null })
    .where(eq(persons.id, personId))
    .run();
  if (r.changes === 0) throw new NotFoundError("人物が見つかりません");
}

/** 人物を完全に削除する（顔写真・ランドマーク・DB の行すべて） */
export async function deletePersonCompletely(personId: string): Promise<void> {
  // 先にファイルを消す。失敗したら DB は残し、やり直せるようにする
  await rm(personDir(personId), { recursive: true, force: true });
  getDb().delete(persons).where(eq(persons.id, personId)).run(); // avatar_assets は cascade で消える
}

export function listAssets(personId: string): AvatarAsset[] {
  return getDb()
    .select()
    .from(avatarAssets)
    .where(eq(avatarAssets.personId, personId))
    .orderBy(desc(avatarAssets.createdAt))
    .all();
}

export function getAsset(assetId: string): AvatarAsset | null {
  return getDb().select().from(avatarAssets).where(eq(avatarAssets.id, assetId)).get() ?? null;
}

export function getActiveAsset(personId: string): AvatarAsset | null {
  return (
    getDb()
      .select()
      .from(avatarAssets)
      .where(and(eq(avatarAssets.personId, personId), eq(avatarAssets.isActive, true)))
      .get() ?? null
  );
}

/** 指定した写真を使用中にし、同じ人物のほかの写真を使用中から外す */
export function activateAsset(personId: string, assetId: string): void {
  const db = getDb();
  db.transaction((tx) => {
    const target = tx
      .select()
      .from(avatarAssets)
      .where(and(eq(avatarAssets.id, assetId), eq(avatarAssets.personId, personId)))
      .get();
    if (!target) throw new NotFoundError("写真が見つかりません");
    tx.update(avatarAssets).set({ isActive: false }).where(eq(avatarAssets.personId, personId)).run();
    tx.update(avatarAssets).set({ isActive: true }).where(eq(avatarAssets.id, assetId)).run();
  });
}

/** 3 つのファイルを書き込み、DB に記録して使用中にする */
export async function saveFaceAsset(input: {
  personId: string;
  originalJpeg: Uint8Array;
  facePng: Uint8Array;
  landmarksJson: string;
  bust: BustFiles | null;
  qualityStatus: StoredQualityStatus;
}): Promise<AvatarAsset> {
  const person = getPerson(input.personId);
  if (!person) throw new NotFoundError("人物が見つかりません");
  if (!person.consentAt) throw new ConsentRequiredError("本人の同意が記録されていません");

  const assetId = crypto.randomUUID();
  const relDir = faceAssetRelDir(input.personId, assetId);
  const absDir = resolveDataPath(relDir);
  const rel = (name: string) => path.posix.join(relDir, name);

  await mkdir(absDir, { recursive: true });
  try {
    await Promise.all([
      writeFile(path.join(/*turbopackIgnore: true*/ absDir, FACE_FILES.original), input.originalJpeg),
      writeFile(path.join(/*turbopackIgnore: true*/ absDir, FACE_FILES.face), input.facePng),
      writeFile(path.join(/*turbopackIgnore: true*/ absDir, FACE_FILES.landmarks), input.landmarksJson, "utf8"),
      input.bust && writeFile(path.join(/*turbopackIgnore: true*/ absDir, FACE_FILES.bust), input.bust.bustPng),
      input.bust && writeFile(path.join(/*turbopackIgnore: true*/ absDir, FACE_FILES.bustCutout), input.bust.cutoutPng),
    ]);
    return getDb().transaction((tx) => {
      tx.update(avatarAssets).set({ isActive: false }).where(eq(avatarAssets.personId, input.personId)).run();
      return tx
        .insert(avatarAssets)
        .values({
          id: assetId,
          personId: input.personId,
          sourcePhotoPath: rel(FACE_FILES.original),
          facePath: rel(FACE_FILES.face),
          landmarksPath: rel(FACE_FILES.landmarks),
          bustPath: input.bust ? rel(FACE_FILES.bust) : null,
          bustCutoutPath: input.bust ? rel(FACE_FILES.bustCutout) : null,
          qualityStatus: input.qualityStatus,
          isActive: true,
        })
        .returning()
        .get();
    });
  } catch (err) {
    await rm(absDir, { recursive: true, force: true });
    throw err;
  }
}

export function listCaptureSessions(personId: string): CaptureSession[] {
  return getDb()
    .select()
    .from(captureSessions)
    .where(eq(captureSessions.personId, personId))
    .orderBy(desc(captureSessions.createdAt))
    .all();
}

export function getCaptureSession(sessionId: string): CaptureSession | null {
  return getDb().select().from(captureSessions).where(eq(captureSessions.id, sessionId)).get() ?? null;
}

/** session.json を読む。壊れていたら null */
export async function readSessionRecord(session: CaptureSession): Promise<SessionRecord | null> {
  try {
    const r = sessionRecordSchema.safeParse(JSON.parse(await readFile(resolveDataPath(session.sessionPath), "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export type CaptureStepFiles = {
  stepId: string;
  originalJpeg: Uint8Array;
  facePng: Uint8Array;
  landmarksJson: string;
  timelineJson: string;
  video: Uint8Array | null;
  /** 正面の段階だけ */
  bust: BustFiles | null;
};

/**
 * カメラ撮影 1 回分を保存する。正面の段階のキーフレームを「使用中の顔」として avatar_assets にも登録する。
 *   data/persons/<personId>/face/<sessionId>/session.json
 *   data/persons/<personId>/face/<sessionId>/<stepId>/{original.jpg, face.png, landmarks.json, timeline.json, clip.webm}
 */
export async function saveCaptureSession(input: {
  personId: string;
  sessionJson: string;
  qualityStatus: StoredQualityStatus;
  frontStepId: string;
  frontQualityStatus: StoredQualityStatus;
  steps: CaptureStepFiles[];
}): Promise<{ session: CaptureSession; asset: AvatarAsset }> {
  const person = getPerson(input.personId);
  if (!person) throw new NotFoundError("人物が見つかりません");
  if (!person.consentAt) throw new ConsentRequiredError("本人の同意が記録されていません");
  if (!input.steps.some((s) => s.stepId === input.frontStepId)) throw new Error("正面の段階がありません");

  const sessionId = crypto.randomUUID();
  const relDir = faceAssetRelDir(input.personId, sessionId);
  const absDir = resolveDataPath(relDir);
  const rel = (...parts: string[]) => path.posix.join(relDir, ...parts);
  const frontBust = input.steps.find((s) => s.stepId === input.frontStepId)?.bust ?? null;

  await mkdir(absDir, { recursive: true });
  try {
    for (const step of input.steps) {
      const stepDir = resolveDataPath(rel(step.stepId));
      await mkdir(stepDir, { recursive: true });
      await Promise.all([
        writeFile(path.join(/*turbopackIgnore: true*/ stepDir, STEP_FILES.original), step.originalJpeg),
        writeFile(path.join(/*turbopackIgnore: true*/ stepDir, STEP_FILES.face), step.facePng),
        writeFile(path.join(/*turbopackIgnore: true*/ stepDir, STEP_FILES.landmarks), step.landmarksJson, "utf8"),
        writeFile(path.join(/*turbopackIgnore: true*/ stepDir, STEP_FILES.timeline), step.timelineJson, "utf8"),
        step.video ? writeFile(path.join(/*turbopackIgnore: true*/ stepDir, STEP_FILES.video), step.video) : null,
        step.bust && writeFile(path.join(/*turbopackIgnore: true*/ stepDir, STEP_FILES.bust), step.bust.bustPng),
        step.bust && writeFile(path.join(/*turbopackIgnore: true*/ stepDir, STEP_FILES.bustCutout), step.bust.cutoutPng),
      ]);
    }
    await writeFile(path.join(/*turbopackIgnore: true*/ absDir, SESSION_FILE), input.sessionJson, "utf8");

    return getDb().transaction((tx) => {
      const session = tx
        .insert(captureSessions)
        .values({
          id: sessionId,
          personId: input.personId,
          dirPath: relDir,
          sessionPath: rel(SESSION_FILE),
          qualityStatus: input.qualityStatus,
          recordedSteps: input.steps.length,
          hasVideo: input.steps.some((s) => s.video !== null),
        })
        .returning()
        .get();
      tx.update(avatarAssets).set({ isActive: false }).where(eq(avatarAssets.personId, input.personId)).run();
      const asset = tx
        .insert(avatarAssets)
        .values({
          id: crypto.randomUUID(),
          personId: input.personId,
          captureSessionId: sessionId,
          sourcePhotoPath: rel(input.frontStepId, STEP_FILES.original),
          facePath: rel(input.frontStepId, STEP_FILES.face),
          landmarksPath: rel(input.frontStepId, STEP_FILES.landmarks),
          bustPath: frontBust ? rel(input.frontStepId, STEP_FILES.bust) : null,
          bustCutoutPath: frontBust ? rel(input.frontStepId, STEP_FILES.bustCutout) : null,
          qualityStatus: input.frontQualityStatus,
          isActive: true,
        })
        .returning()
        .get();
      return { session, asset };
    });
  } catch (err) {
    await rm(absDir, { recursive: true, force: true });
    throw err;
  }
}

/** 後から作った肩から上の画像を登録する */
export function setAssetBust(assetId: string, bustPath: string, bustCutoutPath: string): void {
  getDb().update(avatarAssets).set({ bustPath, bustCutoutPath }).where(eq(avatarAssets.id, assetId)).run();
}

import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const persons = sqliteTable(
  "persons",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** 本人の同意日時。null の人物は顔写真を取り込めない */
    consentAt: integer("consent_at", { mode: "timestamp_ms" }),
    /** 展示画面に出す人物（最大 1 人） */
    isStageSubject: integer("is_stage_subject", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("persons_one_stage_subject").on(t.isStageSubject).where(sql`${t.isStageSubject} = 1`)],
);

export const QUALITY_STATUSES = ["pass", "warn"] as const;
export type StoredQualityStatus = (typeof QUALITY_STATUSES)[number];

/** カメラで撮影した 1 回分（正面・角度・表情・自然な動き） */
export const captureSessions = sqliteTable(
  "capture_sessions",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    /** DATA_DIR からの相対パス（セッションのフォルダ） */
    dirPath: text("dir_path").notNull(),
    /** session.json の相対パス */
    sessionPath: text("session_path").notNull(),
    qualityStatus: text("quality_status", { enum: QUALITY_STATUSES }).notNull(),
    /** 記録した段階の数（省略した段階は含まない） */
    recordedSteps: integer("recorded_steps").notNull(),
    hasVideo: integer("has_video", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("capture_sessions_person_idx").on(t.personId)],
);

export const avatarAssets = sqliteTable(
  "avatar_assets",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    /** カメラで撮ったときのセッション（写真ファイルから取り込んだときは null） */
    captureSessionId: text("capture_session_id").references((): AnySQLiteColumn => captureSessions.id, {
      onDelete: "cascade",
    }),
    /** 以下のパスはすべて DATA_DIR からの相対パス（"/" 区切り） */
    sourcePhotoPath: text("source_photo_path").notNull(),
    facePath: text("face_path").notNull(),
    landmarksPath: text("landmarks_path").notNull(),
    /** 肩から上の画像（顔を動かす処理の元画像）。背景つき / 背景を透明にしたもの。古いデータは null */
    bustPath: text("bust_path"),
    bustCutoutPath: text("bust_cutout_path"),
    /** 不合格は保存しないので pass / warn のみ */
    qualityStatus: text("quality_status", { enum: QUALITY_STATUSES }).notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("avatar_assets_person_idx").on(t.personId),
    // 1人につき使用中は最大1枚
    uniqueIndex("avatar_assets_one_active_per_person")
      .on(t.personId)
      .where(sql`${t.isActive} = 1`),
  ],
);

export type Person = typeof persons.$inferSelect;
export type AvatarAsset = typeof avatarAssets.$inferSelect;
export type CaptureSession = typeof captureSessions.$inferSelect;

import "server-only";
import path from "node:path";

/**
 * 顔写真と DB の保存先。既定はモノレポのルートの data/（Git 管理外）。
 * next は apps/web をカレントにして動くので ../../data になる。環境変数 DATA_DIR で変更できる。
 * 実行時のデータなので turbopackIgnore でビルドの追跡対象から外している。
 */
export const DATA_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR ?? path.join(process.cwd(), "..", "..", "data"));

export const DB_PATH = path.join(DATA_DIR, "app.db");

/** ID は英数字・_・- のみ（パスに埋め込むため。../ などを防ぐ） */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function assertId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`不正な ID: ${id}`);
  return id;
}

/** data/persons/<personId> */
export function personDir(personId: string): string {
  return path.join(DATA_DIR, "persons", assertId(personId));
}

/** DATA_DIR からの相対パス（DB に保存する形） */
export function faceAssetRelDir(personId: string, assetId: string): string {
  return ["persons", assertId(personId), "face", assertId(assetId)].join("/");
}

/** DB に保存した相対パスを絶対パスに戻す。DATA_DIR の外を指していたら拒否する */
export function resolveDataPath(relPath: string): string {
  const abs = path.resolve(DATA_DIR, relPath);
  if (abs !== DATA_DIR && !abs.startsWith(DATA_DIR + path.sep)) {
    throw new Error(`DATA_DIR の外のパス: ${relPath}`);
  }
  return abs;
}

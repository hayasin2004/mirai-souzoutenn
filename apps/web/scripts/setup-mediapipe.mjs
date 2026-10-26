// MediaPipe の WASM とモデル（顔・人物の切り抜き）を public/mediapipe/ に置き、ネットなしで動くようにする。
//   node scripts/setup-mediapipe.mjs            WASM コピー + モデルが無ければダウンロード
//   node scripts/setup-mediapipe.mjs --wasm-only WASM コピーのみ（postinstall 用。ネット不要）
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(webRoot, "public", "mediapipe");
const wasmOut = path.join(outDir, "wasm");
const MODELS = [
  {
    // 顔のランドマーク（478 点・ブレンドシェイプ・顔の向き）
    out: path.join(outDir, "face_landmarker.task"),
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  },
  {
    // 人物の切り抜き（背景・髪・肌・服などに分ける。肩から上の画像の背景を消すのに使う）
    out: path.join(outDir, "selfie_multiclass_256x256.tflite"),
    url: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite",
  },
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyWasm() {
  // package.json は exports に無いので、メインファイルの場所から辿る
  const pkgDir = path.dirname(require.resolve("@mediapipe/tasks-vision"));
  const src = path.join(pkgDir, "wasm");
  await mkdir(wasmOut, { recursive: true });
  for (const name of await readdir(src)) {
    await copyFile(path.join(src, name), path.join(wasmOut, name));
  }
  console.log(`[mediapipe] WASM を ${path.relative(webRoot, wasmOut)} にコピーしました`);
}

async function downloadModels() {
  for (const { out, url } of MODELS) {
    if (await exists(out)) {
      console.log(`[mediapipe] ${path.basename(out)} は配置済みです`);
      continue;
    }
    console.log(`[mediapipe] ダウンロードします: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ダウンロード失敗: HTTP ${res.status}`);
    await writeFile(out, Buffer.from(await res.arrayBuffer()));
    console.log(`[mediapipe] ${path.relative(webRoot, out)} を保存しました`);
  }
}

await copyWasm();
if (!process.argv.includes("--wasm-only")) await downloadModels();

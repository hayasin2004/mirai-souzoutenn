import path from "node:path";
import type { NextConfig } from "next";

// next は apps/web をカレントにして動く。モノレポのルートを明示しておく
const repoRoot = path.resolve(process.cwd(), "..", "..");

/**
 * ブラウザから通信してよい相手。自分のサーバーに加えて、PC-A の顔を動かすサービス
 * （NEXT_PUBLIC_FACE_RENDERER_URL。同じ LAN の中）だけ許す。
 */
function rendererOrigin(): string | null {
  const url = process.env.NEXT_PUBLIC_FACE_RENDERER_URL;
  if (!url || url === "mock" || url.startsWith("/")) return null;
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`NEXT_PUBLIC_FACE_RENDERER_URL が URL ではありません: ${url}`);
  }
}
const connectSrc = ["'self'", rendererOrigin()].filter(Boolean).join(" ");

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // 完全ローカルで動かすため、ブラウザからの通信は自分のサーバーだけに限る。
          // MediaPipe は利用統計を odml.pa.googleapis.com へ送る処理を内蔵しているので、ここで止める。
          { key: "Content-Security-Policy", value: `connect-src ${connectSrc}` },
        ],
      },
    ];
  },
};

export default nextConfig;

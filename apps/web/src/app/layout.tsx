import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "じぶんAI — 記憶アーカイブ端末",
  description: "100年後の未来に残す、じぶんのクローン",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}

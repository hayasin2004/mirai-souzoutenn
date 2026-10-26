import Link from "next/link";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-6 pb-16">
      <header className="flex items-center justify-between border-b border-line py-4">
        <Link href="/admin/persons" className="flex items-baseline gap-3">
          <span className="label">ARCHIVE ADMIN</span>
          <span className="text-sm text-ink-dim">じぶんAI 管理</span>
        </Link>
        <nav className="flex gap-4 text-sm text-ink-dim">
          <Link href="/admin/persons" className="hover:text-holo">人物</Link>
          <Link href="/admin/talk" className="hover:text-holo">しゃべる確認</Link>
          <Link href="/stage/face" className="hover:text-holo">展示画面</Link>
        </nav>
      </header>
      <div className="pt-8">{children}</div>
    </div>
  );
}

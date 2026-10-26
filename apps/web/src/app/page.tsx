import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-8 px-6">
      <div>
        <p className="label">MEMORY ARCHIVE TERMINAL · 2126</p>
        <h1 className="mt-2 text-3xl font-light tracking-wide">じぶんAI</h1>
      </div>
      <nav className="grid gap-3 sm:grid-cols-2">
        <Link href="/admin/persons" className="panel block p-5 hover:border-holo">
          <p className="label">ADMIN</p>
          <p className="mt-1">人物と顔データの管理</p>
        </Link>
        <Link href="/stage/face" className="panel block p-5 hover:border-holo">
          <p className="label">STAGE</p>
          <p className="mt-1">顔表示の確認</p>
        </Link>
      </nav>
    </main>
  );
}

import type { CheckLevel, QualityLevel, QualityReport } from "../quality";

const LEVEL_STYLE: Record<CheckLevel, { text: string; className: string }> = {
  pass: { text: "合格", className: "text-ok border-ok/40" },
  warn: { text: "注意", className: "text-warn border-warn/40" },
  fail: { text: "不合格", className: "text-ng border-ng/50" },
  skip: { text: "—", className: "text-ink-dim border-line" },
};

const OVERALL: Record<QualityLevel, string> = {
  pass: "すべての項目が合格です",
  warn: "注意の項目があります（保存はできます）",
  fail: "不合格の項目があるため保存できません",
};

function formatValue(value: number | null, unit: string): string {
  if (value === null) return "—";
  const digits = unit === "°" || unit === "%" ? 1 : unit === "" && value < 10 ? 2 : 0;
  return `${value.toFixed(digits)}${unit}`;
}

export function LevelBadge({ level }: { level: CheckLevel }) {
  const s = LEVEL_STYLE[level];
  return (
    <span className={`inline-block w-14 rounded-sm border px-1.5 py-0.5 text-center font-mono text-xs ${s.className}`}>
      {s.text}
    </span>
  );
}

export function QualityReportView({ report }: { report: QualityReport }) {
  const tips = report.checks.filter((c) => c.tip);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <LevelBadge level={report.status} />
        <p className="text-sm">{OVERALL[report.status]}</p>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="label text-left">
            <th className="pb-2 font-normal">項目</th>
            <th className="pb-2 text-right font-normal">測定値</th>
            <th className="pb-2 pl-4 font-normal">基準</th>
            <th className="pb-2 text-right font-normal">判定</th>
          </tr>
        </thead>
        <tbody>
          {report.checks.map((c) => (
            <tr key={c.id} className="border-t border-line">
              <td className="py-1.5">{c.label}</td>
              <td className="py-1.5 text-right font-mono">{formatValue(c.value, c.unit)}</td>
              <td className="py-1.5 pl-4 text-xs text-ink-dim">{c.criterion}</td>
              <td className="py-1.5 text-right">
                <LevelBadge level={c.level} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {tips.length > 0 && (
        <div className="space-y-2 rounded-sm border border-line p-3">
          <p className="label">撮り直しのコツ</p>
          <ul className="space-y-1.5 text-sm">
            {tips.map((c) => (
              <li key={c.id} className="flex gap-2">
                <span className={c.level === "fail" ? "text-ng" : "text-warn"}>▸</span>
                <span>
                  <span className="text-ink-dim">{c.label}：</span>
                  {c.tip}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

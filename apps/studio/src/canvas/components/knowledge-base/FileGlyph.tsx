/*
 * FileGlyph —— 知识库页共用的文档纸面图标：白纸 + 右上折角 + 下半彩色徽标带。
 * 「全部文件」与「文档识别」两个面板共用（从 AllFilesPanel 抽出）。
 *
 * 纸面刻意钉白色不随暗色主题翻转——「文件图标 = 纸」与表格预览「文件的纸面
 * 固定浅色」同一决策谱系。
 */

/** 各格式的品牌近似色 + 徽标文字（参考 Office/常见图标语义配色）。 */
const GLYPH: Record<string, { color: string; label: string }> = {
  xlsx: { color: '#21a366', label: 'X' },
  xls: { color: '#21a366', label: 'X' },
  csv: { color: '#21a366', label: 'CSV' },
  doc: { color: '#2b7cd3', label: 'W' },
  docx: { color: '#2b7cd3', label: 'W' },
  ppt: { color: '#ed6c47', label: 'P' },
  pptx: { color: '#ed6c47', label: 'P' },
  pdf: { color: '#e5252a', label: 'PDF' },
  md: { color: '#64748b', label: 'MD' },
  txt: { color: '#8b95a5', label: 'TXT' },
  html: { color: '#6366f1', label: 'HTML' },
};

export function FileGlyph({ ext, className }: { ext: string; className?: string }): React.JSX.Element {
  const g = GLYPH[ext] ?? { color: '#94a3b8', label: ext.toUpperCase().slice(0, 4) };
  const fontSize =
    g.label.length <= 1 ? 13 : g.label.length === 2 ? 10.5 : g.label.length === 3 ? 9 : 7.5;
  return (
    <svg viewBox="0 0 40 48" className={className} aria-hidden="true">
      <path
        d="M6 2.5h19.5L36 13v30.5a2.5 2.5 0 0 1-2.5 2.5h-27A2.5 2.5 0 0 1 4 43.5V5a2.5 2.5 0 0 1 2-2.5z"
        fill="#ffffff"
        stroke="#d3d7dd"
        strokeWidth="1.4"
      />
      <path
        d="M25.5 2.5L36 13h-9a1.5 1.5 0 0 1-1.5-1.5v-9z"
        fill="#eef0f3"
        stroke="#d3d7dd"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <rect x="8" y="24" width="24" height="14" rx="3.5" fill={g.color} />
      <text
        x="20"
        y="31.4"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#ffffff"
        fontSize={fontSize}
        fontWeight={700}
        fontFamily="system-ui, sans-serif"
      >
        {g.label}
      </text>
    </svg>
  );
}

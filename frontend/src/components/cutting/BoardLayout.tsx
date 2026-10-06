import type { PackedBoard } from '../../types/board'

interface BoardLayoutProps {
  packed: PackedBoard
}

const PALETTE = ['#d89a5b', '#c88c55', '#b77942', '#cf9d68', '#bd8248']

/**
 * 按比例绘制一张板的排样：
 * - 浅木纹底色 + 纵向纹线（沿板长）；
 * - 构件按落位坐标绘制，旋转件加斜纹与 R 标；
 * - 回库余料以绿色虚线框标注。
 */
export function BoardLayout({ packed }: BoardLayoutProps) {
  const maxWidth = 560
  const scale = Math.min(8, maxWidth / packed.lengthMm)
  const drawingW = packed.lengthMm * scale
  const drawingH = packed.widthMm * scale

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
        <strong className="text-sm text-wood-900">{packed.boardCode}</strong>
        <span className="rounded-full bg-wood-50 px-2 py-0.5">{packed.grainDir}板</span>
        <span>{packed.lengthMm}×{packed.widthMm}×{packed.thicknessMm}mm</span>
        <span className="text-stone-400">共 {packed.placements.length} 件{packed.remnants.length > 0 ? ` · 回存余料 ${packed.remnants.length} 块` : ''}</span>
      </div>
      <svg
        viewBox={`-6 -6 ${drawingW + 12} ${drawingH + 12}`}
        className="w-full rounded-lg border border-wood-100"
        style={{ background: '#f7efe3' }}
        role="img"
        aria-label={`${packed.boardCode} 排样图`}
      >
        {Array.from({ length: Math.ceil(packed.lengthMm / 90) + 1 }, (_, index) => {
          const x = index * 90 * scale
          return x <= drawingW ? (
            <line key={`grain-${index}`} x1={x} y1={0} x2={x} y2={drawingH} stroke="#e3cfae" strokeWidth={1} strokeDasharray="3 6" />
          ) : null
        })}
        <rect x={0} y={0} width={drawingW} height={drawingH} fill="none" stroke="#6f4a26" strokeWidth={2} />

        {packed.remnants.map((remnant, index) => (
          <rect
            key={`remnant-${index}`}
            x={remnant.xMm * scale}
            y={remnant.yMm * scale}
            width={remnant.wMm * scale}
            height={remnant.hMm * scale}
            fill="rgba(16,185,129,0.08)"
            stroke="#059669"
            strokeWidth={1.2}
            strokeDasharray="5 3"
          />
        ))}

        {packed.placements.map((placement, index) => {
          const x = placement.xMm * scale
          const y = placement.yMm * scale
          const w = placement.wMm * scale
          const h = placement.hMm * scale
          const color = PALETTE[index % PALETTE.length]
          const labelSize = Math.min(12, Math.max(8, h * 0.38))
          return (
            <g key={`${placement.memberId}-${index}`}>
              <rect x={x} y={y} width={w} height={h} fill={color} stroke="#593619" strokeWidth={1.4} />
              {placement.rotated ? (
                <path
                  d={`M${x} ${y + h} L${x + w} ${y}`}
                  stroke="rgba(89,54,25,0.45)"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
              ) : null}
              {w > 34 && h > 16 ? (
                <text
                  x={x + 4}
                  y={y + labelSize + 2}
                  fill="#2f1c0c"
                  fontSize={labelSize}
                  fontFamily="sans-serif"
                >
                  {placement.memberName}{placement.rotated ? ' R' : ''}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-stone-500">
        {packed.placements.map((placement, index) => (
          <li key={`legend-${placement.memberId}-${index}`}>
            <span className="mr-1 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: PALETTE[index % PALETTE.length] }} />
            {placement.memberName}（{placement.rotated ? `${placement.hMm}×${placement.wMm}mm，旋转90°` : `${placement.wMm}×${placement.hMm}mm`}）
          </li>
        ))}
        {packed.remnants.map((remnant, index) => (
          <li key={`remnant-label-${index}`} className="text-emerald-700">
            余料 {Math.max(remnant.wMm, remnant.hMm)}×{Math.min(remnant.wMm, remnant.hMm)}mm 回库
          </li>
        ))}
      </ul>
    </div>
  )
}

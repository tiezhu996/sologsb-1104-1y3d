import type { Placement, UsedBoard } from '../../types/cutting'

interface PlanBoardSvgProps {
  usedBoard: UsedBoard
  sawKerfMm: number
}

const PALETTE = [
  { fill: '#d89a5b', stroke: '#6f4a26' },
  { fill: '#b77942', stroke: '#593619' },
  { fill: '#c88c55', stroke: '#66401f' },
  { fill: '#a9743f', stroke: '#4b2d17' },
  { fill: '#e0b07c', stroke: '#7a532a' },
  { fill: '#9c6b3c', stroke: '#3d2814' },
]

function colorFor(id: string): { fill: string; stroke: string } {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

function fitLabel(lengthMm: number, widthMm: number): number {
  return Math.max(9, Math.min(15, Math.min(lengthMm, widthMm) / 4.2))
}

/** 单板排样图：木纹沿板纹方向绘制，构件带编号与转向标记，虚线框为回库余料 */
export function PlanBoardSvg({ usedBoard, sawKerfMm }: PlanBoardSvgProps) {
  const pad = 46
  const L = usedBoard.lengthMm
  const W = usedBoard.widthMm
  const horizontalGrain = usedBoard.grain === 'along'
  const grainStep = 26

  return (
    <svg
      viewBox={`${-pad} ${-pad - 18} ${L + pad * 2} ${W + pad * 2 + 18}`}
      className="h-auto w-full"
      role="img"
      aria-label={`板材 ${usedBoard.code} 排样图`}
    >
      {/* 板材边界 */}
      <rect x={0} y={0} width={L} height={W} rx={4} fill="#f7efe3" stroke="#8c6b4b" strokeWidth={2.5} />
      {/* 木纹：顺纹板沿长边（水平），横纹板沿短边（竖直） */}
      {horizontalGrain
        ? Array.from({ length: Math.floor(W / grainStep) }, (_, i) => (
            <line key={`g-${i}`} x1={0} y1={(i + 1) * grainStep} x2={L} y2={(i + 1) * grainStep}
              stroke="#d9bd97" strokeWidth={1} strokeDasharray="2 7" />
          ))
        : Array.from({ length: Math.floor(L / grainStep) }, (_, i) => (
            <line key={`g-${i}`} x1={(i + 1) * grainStep} y1={0} x2={(i + 1) * grainStep} y2={W}
              stroke="#d9bd97" strokeWidth={1} strokeDasharray="2 7" />
          ))}

      {/* 余料（回库） */}
      {usedBoard.offcuts.map((offcut, index) => (
        <g key={`offcut-${index}`}>
          <rect
            x={offcut.x}
            y={offcut.y}
            width={offcut.lengthMm}
            height={offcut.widthMm}
            fill="rgba(72, 128, 78, 0.08)"
            stroke="#48804e"
            strokeWidth={1.6}
            strokeDasharray="7 5"
          />
          <text
            x={offcut.x + offcut.lengthMm / 2}
            y={offcut.y + offcut.widthMm / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#3f6b43"
            fontSize={fitLabel(offcut.lengthMm, offcut.widthMm)}
          >
            余料 {usedBoard.code}-Y{index + 1}
          </text>
          <text
            x={offcut.x + offcut.lengthMm / 2}
            y={offcut.y + offcut.widthMm / 2 + fitLabel(offcut.lengthMm, offcut.widthMm) + 3}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#5d8a61"
            fontSize={fitLabel(offcut.lengthMm, offcut.widthMm) - 2}
          >
            {Math.round(offcut.lengthMm)}×{Math.round(offcut.widthMm)} 回库
          </text>
        </g>
      ))}

      {/* 构件落位 */}
      {usedBoard.placements.map((placement: Placement) => {
        const color = colorFor(placement.componentId)
        const fontSize = fitLabel(placement.lengthMm, placement.widthMm)
        return (
          <g key={`${placement.componentId}-${placement.seq}`}>
            <rect
              x={placement.x}
              y={placement.y}
              width={placement.lengthMm}
              height={placement.widthMm}
              rx={2}
              fill={color.fill}
              stroke={color.stroke}
              strokeWidth={2}
            />
            {/* 顺纹标记：构件长边方向画木纹线 */}
            {Array.from({ length: Math.max(1, Math.floor(Math.min(placement.lengthMm, placement.widthMm) / 16)) }, (_, i) => {
              const t = (i + 1) * (placement.rotated ? placement.lengthMm : placement.widthMm)
                / (Math.floor(Math.min(placement.lengthMm, placement.widthMm) / 16) + 1)
              return placement.rotated ? (
                <line key={i}
                  x1={placement.x + t} y1={placement.y + 3}
                  x2={placement.x + t} y2={placement.y + placement.widthMm - 3}
                  stroke="rgba(61,40,20,0.28)" strokeWidth={1} strokeDasharray="3 5" />
              ) : (
                <line key={i}
                  x1={placement.x + 3} y1={placement.y + t}
                  x2={placement.x + placement.lengthMm - 3} y2={placement.y + t}
                  stroke="rgba(61,40,20,0.28)" strokeWidth={1} strokeDasharray="3 5" />
              )
            })}
            <text
              x={placement.x + placement.lengthMm / 2}
              y={placement.y + placement.widthMm / 2 - fontSize / 2 + 1}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="#2f1c0c"
              fontSize={fontSize}
              fontWeight={700}
            >
              {placement.name} #{placement.seq}
            </text>
            <text
              x={placement.x + placement.lengthMm / 2}
              y={placement.y + placement.widthMm / 2 + fontSize / 2 + 3}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="rgba(47,28,12,0.78)"
              fontSize={fontSize - 2.5}
            >
              {Math.round(placement.lengthMm)}×{Math.round(placement.widthMm)}
              {placement.rotated ? ' · 转向90°' : ''}
            </text>
          </g>
        )
      })}

      {/* 尺寸标注 */}
      <text x={L / 2} y={-16} textAnchor="middle" fill="#6f4a26" fontSize={14} fontWeight={700}>
        {usedBoard.code} · {usedBoard.species} · {usedBoard.grain === 'along' ? '顺纹板' : '横纹板'} · {L}×{W}×{usedBoard.thicknessMm}mm
      </text>
      <text x={L + 10} y={W + 4} fill="#8c6b4b" fontSize={11}>
        {L}mm
      </text>
      <text x={4} y={W + 18} fill="#8c6b4b" fontSize={11}>
        {W}mm
      </text>
      {sawKerfMm > 0 ? (
        <text x={0} y={-2} fill="#a3744a" fontSize={10}>
          锯路 {sawKerfMm}mm 已计入占位
        </text>
      ) : null}
    </svg>
  )
}

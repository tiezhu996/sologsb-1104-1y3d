import { useCuttingStore } from '../../stores/cuttingStore'

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function RecordsPanel() {
  const records = useCuttingStore((state) => state.records)

  if (records.length === 0) {
    return <p className="panel px-5 py-10 text-center text-sm text-stone-500">尚无开料记录。确认排样后会在此留账。</p>
  }

  return (
    <div className="space-y-4">
      {records.map((record) => (
        <article key={record.id} className="panel overflow-hidden">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-wood-100 bg-wood-50/60 px-5 py-3">
            <div>
              <strong className="text-wood-900">批号 {record.batchNo}</strong>
              <span className="ml-3 text-xs text-stone-500">{formatTime(record.cutAt)}</span>
            </div>
            <span className="text-xs text-wood-700">{record.memberCount} 件 · 用板 {record.consumedBoards.length} 张 · 回存余料 {record.returnedRemnants.length} 块</span>
          </header>
          <div className="grid gap-4 p-5 lg:grid-cols-2">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-stone-500">构件落位</h4>
              <ul className="mt-2 space-y-1.5 text-sm text-stone-700">
                {record.placements.map((placement, index) => (
                  <li key={`${record.id}-p-${index}`} className="flex flex-wrap items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-sm bg-wood-500" />
                    <strong>{placement.memberName}</strong>
                    <span className="text-xs text-stone-500">
                      {placement.grainDir} · {placement.lengthMm}×{placement.widthMm}mm
                      {placement.rotated ? ' · 旋转90°' : ''}
                    </span>
                    <span className="rounded bg-wood-50 px-1.5 py-0.5 text-[11px] text-wood-700">{placement.boardCode}</span>
                  </li>
                ))}
              </ul>
              {record.note ? <p className="mt-3 text-xs text-stone-500">备注：{record.note}</p> : null}
            </div>
            <div className="space-y-3">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-stone-500">扣减板材</h4>
                <ul className="mt-2 space-y-1 text-sm text-stone-700">
                  {record.consumedBoards.map((board) => (
                    <li key={board.boardId}>
                      {board.boardCode}
                      <span className="ml-2 text-xs text-stone-500">
                        {board.grainDir} · {board.lengthMm}×{board.widthMm}×{board.thicknessMm}mm
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-emerald-700">回存余料</h4>
                {record.returnedRemnants.length === 0 ? (
                  <p className="mt-2 text-sm text-stone-500">本批无可用余料，切剩均为碎料。</p>
                ) : (
                  <ul className="mt-2 space-y-1 text-sm text-stone-700">
                    {record.returnedRemnants.map((remnant) => (
                      <li key={remnant.boardId}>
                        {remnant.boardCode}
                        <span className="ml-2 text-xs text-stone-500">
                          {remnant.grainDir} · {remnant.lengthMm}×{remnant.widthMm}×{remnant.thicknessMm}mm
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="text-[11px] text-stone-400">碎料废弃面积 {Math.round(record.wasteAreaMm2).toLocaleString('zh-CN')} mm²</p>
            </div>
          </div>
        </article>
      ))}
    </div>
  )
}

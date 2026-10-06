import { useState } from 'react'
import type { Board } from '../../types/board'
import { useCuttingStore } from '../../stores/cuttingStore'
import type { BoardDraft } from '../../stores/cuttingStore'
import type { GrainDirection } from '../../types/member'

const EMPTY_DRAFT: BoardDraft = {
  code: '',
  grainDir: '顺纹',
  lengthMm: 1200,
  widthMm: 150,
  thicknessMm: 30,
  note: '',
}

export function StockPanel() {
  const boards = useCuttingStore((state) => state.boards)
  const addBoard = useCuttingStore((state) => state.addBoard)
  const deleteBoard = useCuttingStore((state) => state.deleteBoard)
  const [draft, setDraft] = useState<BoardDraft>(EMPTY_DRAFT)
  const [error, setError] = useState<string | null>(null)

  const fullBoards = boards.filter((board) => !board.isRemnant)
  const remnants = boards.filter((board) => board.isRemnant)

  const submit = async () => {
    if (!draft.code.trim()) {
      setError('请填写料牌编码。')
      return
    }
    if (boards.some((board) => board.code === draft.code.trim())) {
      setError('该料牌编码已存在，避免与库内其它板材混淆。')
      return
    }
    if (draft.lengthMm <= 0 || draft.widthMm <= 0 || draft.thicknessMm <= 0) {
      setError('板材长宽厚必须为正数。')
      return
    }
    setError(null)
    await addBoard(draft)
    setDraft(EMPTY_DRAFT)
  }

  return (
    <div className="space-y-5">
      <section className="panel p-5">
        <h3 className="font-semibold text-wood-900">整板入库</h3>
        <p className="mt-1 text-xs text-stone-500">纹理沿板材长边登记；顺纹板只能开顺纹件。</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <label className="space-y-1 text-xs text-stone-600 lg:col-span-2">
            料牌编码
            <input
              className="input-field"
              value={draft.code}
              placeholder="如 SB-S-003"
              onChange={(event) => setDraft({ ...draft, code: event.target.value })}
            />
          </label>
          <label className="space-y-1 text-xs text-stone-600">
            纹向
            <select
              className="input-field"
              value={draft.grainDir}
              onChange={(event) => setDraft({ ...draft, grainDir: event.target.value as GrainDirection })}
            >
              <option value="顺纹">顺纹</option>
              <option value="横纹">横纹</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-stone-600">
            长 mm（纹向）
            <input
              type="number" min={1} className="input-field" value={draft.lengthMm}
              onChange={(event) => setDraft({ ...draft, lengthMm: Number(event.target.value) })}
            />
          </label>
          <label className="space-y-1 text-xs text-stone-600">
            宽 mm
            <input
              type="number" min={1} className="input-field" value={draft.widthMm}
              onChange={(event) => setDraft({ ...draft, widthMm: Number(event.target.value) })}
            />
          </label>
          <label className="space-y-1 text-xs text-stone-600">
            厚 mm
            <input
              type="number" min={1} className="input-field" value={draft.thicknessMm}
              onChange={(event) => setDraft({ ...draft, thicknessMm: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            className="input-field max-w-xs"
            placeholder="备注（树种等，可选）"
            value={draft.note}
            onChange={(event) => setDraft({ ...draft, note: event.target.value })}
          />
          <button type="button" className="primary-button" onClick={() => void submit()}>登记入库</button>
          {error ? <span className="text-xs text-rose-700">{error}</span> : null}
        </div>
      </section>

      <BoardGroup title="整板库存" boards={fullBoards} onDelete={(id) => void deleteBoard(id)} />
      <BoardGroup title="回库余料" boards={remnants} onDelete={(id) => void deleteBoard(id)} remnant />
    </div>
  )
}

function BoardGroup({ title, boards, remnant, onDelete }: {
  title: string
  boards: Board[]
  remnant?: boolean
  onDelete: (id: string) => void
}) {
  return (
    <section className="panel overflow-hidden">
      <div className="border-b border-wood-100 bg-wood-50/60 px-5 py-3 text-sm font-semibold text-wood-900">
        {title} <span className="ml-1 text-xs font-normal text-stone-500">{boards.length} 张</span>
      </div>
      {boards.length === 0 ? (
        <p className="px-5 py-6 text-sm text-stone-500">{remnant ? '尚无回库余料。' : '库存为空，请先登记整板。'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-xs text-wood-700">
              <tr className="border-b border-wood-100">
                <th className="px-5 py-2.5 font-semibold">料牌</th>
                <th className="px-3 py-2.5 font-semibold">纹向</th>
                <th className="px-3 py-2.5 font-semibold">长×宽×厚 mm</th>
                <th className="px-3 py-2.5 font-semibold">来源 / 备注</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {boards.map((board) => (
                <tr key={board.id}>
                  <td className="px-5 py-3 font-medium text-stone-900">{board.code}</td>
                  <td className="px-3 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${
                      board.grainDir === '顺纹' ? 'bg-amber-50 text-amber-800' : 'bg-stone-100 text-stone-700'
                    }`}>{board.grainDir}</span>
                  </td>
                  <td className="px-3 py-3 text-stone-600">{board.lengthMm}×{board.widthMm}×{board.thicknessMm}</td>
                  <td className="px-3 py-3 text-xs text-stone-500">
                    {board.isRemnant ? `余料 · 源自 ${board.sourceBoardId ?? '—'}` : '整板'}
                    {board.note ? ` · ${board.note}` : ''}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      className="text-xs text-rose-600 hover:underline"
                      onClick={() => onDelete(board.id)}
                    >
                      移出库存
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

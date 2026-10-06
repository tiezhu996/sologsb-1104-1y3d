import { useEffect, useState, type FormEvent } from 'react'
import { BlankPanel } from '../components/common/BlankPanel'
import { PlanBoardSvg } from '../components/cutting/PlanBoardSvg'
import { useCutStore, type ComponentDraft, ConfirmConflictError } from '../stores/cutStore'
import { onCuttingMessage } from '../utils/cuttingBus'
import type { BoardGrain, GrainRequirement } from '../types/cutting'
import type { RejectReason } from '../utils/packing'

function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const grainLabel: Record<BoardGrain, string> = { along: '顺纹板', cross: '横纹板' }
const modeLabel: Record<GrainRequirement, string> = { along: '顺纹件', any: '任意纹' }

interface NumberInputProps {
  label: string
  value: number
  step?: number
  min?: number
  onChange: (value: number) => void
  suffix?: string
}

function NumberInput({ label, value, step = 1, min = 0, onChange, suffix }: NumberInputProps) {
  return (
    <label className="space-y-1 text-sm">
      <span className="text-xs font-medium text-stone-600">{label}</span>
      <span className="flex items-center rounded-lg border border-wood-100 bg-white focus-within:border-wood-500 focus-within:ring-2 focus-within:ring-wood-100">
        <input
          type="number"
          className="min-w-0 flex-1 rounded-lg bg-transparent px-2.5 py-1.5 text-sm text-stone-800 outline-none"
          value={Number.isFinite(value) ? value : ''}
          step={step}
          min={min}
          onChange={(event) => {
            const next = Number.parseFloat(event.target.value)
            onChange(Number.isFinite(next) ? next : 0)
          }}
        />
        {suffix ? <span className="px-2 text-xs text-stone-500">{suffix}</span> : null}
      </span>
    </label>
  )
}

export default function CuttingBench() {
  const boards = useCutStore((state) => state.boards)
  const components = useCutStore((state) => state.components)
  const draft = useCutStore((state) => state.draft)
  const records = useCutStore((state) => state.records)
  const loading = useCutStore((state) => state.loading)
  const loadAll = useCutStore((state) => state.loadAll)
  const syncRemote = useCutStore((state) => state.syncRemote)
  const addBoard = useCutStore((state) => state.addBoard)
  const updateBoard = useCutStore((state) => state.updateBoard)
  const addComponent = useCutStore((state) => state.addComponent)
  const updateComponent = useCutStore((state) => state.updateComponent)
  const removeComponent = useCutStore((state) => state.removeComponent)
  const saveDraftMeta = useCutStore((state) => state.saveDraftMeta)
  const generatePlan = useCutStore((state) => state.generatePlan)
  const confirmPlan = useCutStore((state) => state.confirmPlan)

  const [rejectReasons, setRejectReasons] = useState<RejectReason[]>([])
  const [planning, setPlanning] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [successRecordId, setSuccessRecordId] = useState<string | null>(null)

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // 跨页签：库存/构件变动或他页签确认后即时同步
  useEffect(() => onCuttingMessage(() => {
    void syncRemote()
    setConfirmError(null)
  }), [syncRemote])

  // 窗口重新聚焦时兜底同步（BroadcastChannel 不可用的环境仍能最终一致）
  useEffect(() => {
    const onFocus = () => void syncRemote()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [syncRemote])

  const inStockBoards = boards.filter((board) => board.status === 'in_stock')
  const consumedBoards = boards.filter((board) => board.status === 'consumed')
  const offcutBoards = boards.filter((board) => board.source === 'offcut' && board.status === 'in_stock')
  const totalPieces = components.reduce((sum, component) => sum + component.qty, 0)

  const runPlan = async () => {
    setPlanning(true)
    setRejectReasons([])
    setConfirmError(null)
    try {
      const { result } = await generatePlan()
      if (!result.ok) setRejectReasons(result.reasons)
    } finally {
      setPlanning(false)
    }
  }

  const runConfirm = async () => {
    setConfirming(true)
    setConfirmError(null)
    try {
      const { recordId } = await confirmPlan()
      setSuccessRecordId(recordId)
      setRejectReasons([])
      window.setTimeout(() => setSuccessRecordId(null), 6000)
    } catch (error) {
      if (error instanceof ConfirmConflictError) {
        setConfirmError(error.message)
        await syncRemote()
      } else {
        setConfirmError('确认开料失败，请重试。')
      }
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="space-y-7" data-testid="cutting-bench">
      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-2 text-xs font-semibold tracking-[0.24em] text-wood-500">CUTTING BENCH</p>
          <h1 className="text-3xl font-bold tracking-tight text-wood-900 sm:text-4xl">开料台 · 排样与扣料</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-stone-600">
            从现有板材给待加工构件排样：顺纹件只用顺纹板，构件不越界、不重叠；容量或纹向不足整批拒绝。
            确认后一次扣减整板、回存余料并记入开料流水，两个页签同时提交同一批木料只成功一次。
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="rounded-xl border border-wood-100 bg-white px-4 py-2.5 text-sm text-stone-600 shadow-sm">
            在库 <span className="mx-1 text-lg font-bold text-wood-700" data-testid="count-board">{inStockBoards.length}</span> 块
          </div>
          <div className="rounded-xl border border-wood-100 bg-white px-4 py-2.5 text-sm text-stone-600 shadow-sm">
            待开 <span className="mx-1 text-lg font-bold text-wood-700" data-testid="count-piece">{totalPieces}</span> 件
          </div>
          <div className="rounded-xl border border-wood-100 bg-white px-4 py-2.5 text-sm text-stone-600 shadow-sm">
            流水 <span className="mx-1 text-lg font-bold text-wood-700" data-testid="count-record">{records.length}</span> 笔
          </div>
        </div>
      </section>

      {successRecordId ? (
        <div className="flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 px-5 py-4 text-sm text-green-800" data-testid="confirm-success">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><path d="m5 13 4 4L19 7" /></svg>
          <span>
            开料已确认：整板已扣减、余料已回库，开料流水 <strong>{successRecordId}</strong> 可在页面底部查阅。
          </span>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <div className="space-y-6">
          <BoardPanel
            boards={boards}
            inStock={inStockBoards.length}
            consumed={consumedBoards.length}
            offcuts={offcutBoards.length}
            loading={loading}
            onAdd={addBoard}
            onUpdate={updateBoard}
          />
          <ComponentPanel
            components={components}
            onAdd={addComponent}
            onUpdate={updateComponent}
            onRemove={removeComponent}
          />
        </div>

        <div className="space-y-6">
          <BatchPanel
            draftName={draft?.name ?? '新开料批'}
            draftNote={draft?.note ?? ''}
            sawKerfMm={draft?.sawKerfMm ?? 2}
            minOffcutMm={draft?.minOffcutMm ?? 120}
            onSaveMeta={saveDraftMeta}
            onPlan={() => void runPlan()}
            onConfirm={() => void runConfirm()}
            planning={planning}
            confirming={confirming}
            hasPlan={!!draft?.plan}
            invalidated={draft?.invalidated ?? false}
            staleReason={draft?.staleReason}
            rejectReasons={rejectReasons}
            confirmError={confirmError}
            componentCount={components.length}
            boardCount={inStockBoards.length}
          />
          <PlanPanel />
        </div>
      </div>

      <RecordsPanel records={records} />
    </div>
  )
}

/* ------------------------------ 板材台账 ------------------------------ */

interface BoardPanelProps {
  boards: ReturnType<typeof useCutStore.getState>['boards']
  inStock: number
  consumed: number
  offcuts: number
  loading: boolean
  onAdd: ReturnType<typeof useCutStore.getState>['addBoard']
  onUpdate: ReturnType<typeof useCutStore.getState>['updateBoard']
}

function BoardPanel({ boards, inStock, consumed, offcuts, onAdd, onUpdate }: BoardPanelProps) {
  const [form, setForm] = useState({ code: '', species: '榉木', grain: 'along' as BoardGrain, lengthMm: 800, widthMm: 200, thicknessMm: 30 })

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (form.lengthMm <= 0 || form.widthMm <= 0 || form.thicknessMm <= 0) return
    await onAdd(form)
    setForm((current) => ({ ...current, code: '' }))
  }

  return (
    <section className="panel p-5" data-testid="panel-boards">
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-wood-900">板材台账</h2>
        <p className="mt-1 text-xs text-stone-500">
          在库 {inStock} 块 · 其中余料回库 {offcuts} 块 · 已开耗 {consumed} 块
        </p>
      </header>

      <form className="grid grid-cols-2 gap-3 rounded-xl bg-wood-50/70 p-3" onSubmit={(event) => void submit(event)} data-testid="form-board">
        <label className="space-y-1 text-sm">
          <span className="text-xs text-stone-600">料号（留空自动）</span>
          <input className="input-field py-1.5" value={form.code} placeholder="YL-005"
            onChange={(event) => setForm((c) => ({ ...c, code: event.target.value }))} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs text-stone-600">木种</span>
          <input className="input-field py-1.5" value={form.species} required
            onChange={(event) => setForm((c) => ({ ...c, species: event.target.value }))} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs text-stone-600">木纹方向</span>
          <select className="input-field py-1.5" value={form.grain}
            onChange={(event) => setForm((c) => ({ ...c, grain: event.target.value as BoardGrain }))}>
            <option value="along">顺纹板（纹理沿长边）</option>
            <option value="cross">横纹板（纹理沿短边）</option>
          </select>
        </label>
        <div className="grid grid-cols-3 gap-2">
          <NumberInput label="长 mm" value={form.lengthMm} onChange={(v) => setForm((c) => ({ ...c, lengthMm: v }))} />
          <NumberInput label="宽 mm" value={form.widthMm} onChange={(v) => setForm((c) => ({ ...c, widthMm: v }))} />
          <NumberInput label="厚 mm" value={form.thicknessMm} step={0.5} onChange={(v) => setForm((c) => ({ ...c, thicknessMm: v }))} />
        </div>
        <button type="submit" className="primary-button col-span-2" data-testid="submit-board">板材入库</button>
      </form>

      <ul className="mt-4 max-h-[360px] space-y-2 overflow-auto pr-1">
        {boards.map((board) => {
          const consumed = board.status === 'consumed'
          return (
            <li
              key={board.id}
              className={`rounded-xl border px-3 py-2.5 text-sm ${consumed ? 'border-stone-200 bg-stone-50 text-stone-400' : 'border-wood-100 bg-white'}`}
              data-testid="row-board"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  {board.code} · {board.species}
                  {board.source === 'offcut' ? <span className="ml-2 rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-700">余料回库</span> : null}
                </span>
                <span className="text-xs">{grainLabel[board.grain]}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-xs text-stone-500">
                  {consumed ? '已开耗' : `${board.lengthMm}×${board.widthMm}×${board.thicknessMm}mm`}
                </span>
                {!consumed ? (
                  <span className="flex items-center gap-1.5">
                    {([
                      ['lengthMm', '长'],
                      ['widthMm', '宽'],
                    ] as const).map(([field, label]) => (
                      <label key={field} className="flex items-center gap-1 text-[11px] text-stone-500">
                        {label}
                        <input
                          type="number"
                          className="w-16 rounded border border-wood-100 px-1.5 py-0.5 text-xs"
                          defaultValue={board[field]}
                          onBlur={(event) => {
                            const value = Number.parseFloat(event.target.value)
                            if (Number.isFinite(value) && value > 0 && value !== board[field]) {
                              void onUpdate(board.id, { [field]: value })
                            } else {
                              event.target.value = String(board[field])
                            }
                          }}
                        />
                      </label>
                    ))}
                  </span>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/* ------------------------------ 构件清单 ------------------------------ */

interface ComponentPanelProps {
  components: ReturnType<typeof useCutStore.getState>['components']
  onAdd: ReturnType<typeof useCutStore.getState>['addComponent']
  onUpdate: ReturnType<typeof useCutStore.getState>['updateComponent']
  onRemove: ReturnType<typeof useCutStore.getState>['removeComponent']
}

function ComponentPanel({ components, onAdd, onUpdate, onRemove }: ComponentPanelProps) {
  const [form, setForm] = useState<ComponentDraft>({
    name: '', grainMode: 'along', lengthMm: 300, widthMm: 50, thicknessMm: 30, qty: 1,
  })

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.name.trim() || form.lengthMm <= 0 || form.widthMm <= 0 || form.thicknessMm <= 0 || form.qty <= 0) return
    await onAdd({ ...form, name: form.name.trim() })
    setForm((current) => ({ ...current, name: '' }))
  }

  return (
    <section className="panel p-5" data-testid="panel-components">
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-wood-900">待加工构件</h2>
        <p className="mt-1 text-xs text-stone-500">顺纹件只能排进顺纹板；改尺寸或纹向后旧排样立即失效。</p>
      </header>

      <form className="grid grid-cols-2 gap-3 rounded-xl bg-wood-50/70 p-3" onSubmit={(event) => void submit(event)} data-testid="form-component">
        <label className="space-y-1 text-sm">
          <span className="text-xs text-stone-600">构件名称</span>
          <input className="input-field py-1.5" value={form.name} required placeholder="如：大边料"
            onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs text-stone-600">下刀纹向</span>
          <select className="input-field py-1.5" value={form.grainMode}
            onChange={(event) => setForm((c) => ({ ...c, grainMode: event.target.value as GrainRequirement }))}>
            <option value="along">顺纹件（锁木纹方向）</option>
            <option value="any">任意纹（可转向）</option>
          </select>
        </label>
        <div className="col-span-2 grid grid-cols-4 gap-2">
          <NumberInput label="长 mm" value={form.lengthMm} onChange={(v) => setForm((c) => ({ ...c, lengthMm: v }))} />
          <NumberInput label="宽 mm" value={form.widthMm} onChange={(v) => setForm((c) => ({ ...c, widthMm: v }))} />
          <NumberInput label="厚 mm" value={form.thicknessMm} step={0.5} onChange={(v) => setForm((c) => ({ ...c, thicknessMm: v }))} />
          <NumberInput label="件数" value={form.qty} min={1} onChange={(v) => setForm((c) => ({ ...c, qty: Math.max(1, Math.round(v)) }))} />
        </div>
        <button type="submit" className="primary-button col-span-2" data-testid="submit-component">加入待开清单</button>
      </form>

      {components.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-wood-100 px-4 py-6 text-center text-xs text-stone-500">
          还没有待加工构件
        </p>
      ) : (
        <ul className="mt-4 max-h-[360px] space-y-2 overflow-auto pr-1">
          {components.map((component) => (
            <li key={component.id} className="rounded-xl border border-wood-100 bg-white px-3 py-2.5 text-sm" data-testid="row-component">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  <input
                    className="w-24 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium hover:border-wood-100 focus:border-wood-500 focus:bg-white focus:outline-none"
                    defaultValue={component.name}
                    onBlur={(event) => {
                      const name = event.target.value.trim()
                      if (name && name !== component.name) void onUpdate(component.id, { name })
                      else event.target.value = component.name
                    }}
                  />
                  <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] ${component.grainMode === 'along' ? 'bg-amber-50 text-amber-800' : 'bg-stone-100 text-stone-600'}`}>
                    {modeLabel[component.grainMode]}
                  </span>
                </span>
                <button
                  type="button"
                  className="text-xs text-stone-400 hover:text-red-600"
                  onClick={() => void onRemove(component.id)}
                  data-testid={`remove-component-${component.id}`}
                >
                  删除
                </button>
              </div>
              <div className="mt-1.5 grid grid-cols-5 gap-1.5">
                {([
                  ['lengthMm', '长'],
                  ['widthMm', '宽'],
                  ['thicknessMm', '厚'],
                  ['qty', '数'],
                ] as const).map(([field, label]) => (
                  <label key={field} className="flex items-center gap-1 text-[11px] text-stone-500">
                    {label}
                    <input
                      type="number"
                      className="w-full min-w-0 rounded border border-wood-100 px-1.5 py-0.5 text-xs"
                      defaultValue={component[field]}
                      onBlur={(event) => {
                        const raw = Number.parseFloat(event.target.value)
                        if (!Number.isFinite(raw) || raw <= 0) {
                          event.target.value = String(component[field])
                          return
                        }
                        const value = field === 'qty' ? Math.max(1, Math.round(raw)) : raw
                        if (value !== component[field]) void onUpdate(component.id, { [field]: value })
                        else event.target.value = String(component[field])
                      }}
                    />
                  </label>
                ))}
                <span className="self-center text-right text-[10px] text-stone-400">mm</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ------------------------------ 批次与排样操作 ------------------------------ */

interface BatchPanelProps {
  draftName: string
  draftNote: string
  sawKerfMm: number
  minOffcutMm: number
  onSaveMeta: ReturnType<typeof useCutStore.getState>['saveDraftMeta']
  onPlan: () => void
  onConfirm: () => void
  planning: boolean
  confirming: boolean
  hasPlan: boolean
  invalidated: boolean
  staleReason?: string
  rejectReasons: RejectReason[]
  confirmError: string | null
  componentCount: number
  boardCount: number
}

function BatchPanel(props: BatchPanelProps) {
  const {
    draftName, draftNote, sawKerfMm, minOffcutMm, onSaveMeta, onPlan, onConfirm,
    planning, confirming, hasPlan, invalidated, staleReason, rejectReasons, confirmError,
    componentCount, boardCount,
  } = props
  const [name, setName] = useState(draftName)
  const [note, setNote] = useState(draftNote)
  const [kerf, setKerf] = useState(sawKerfMm)
  const [minOffcut, setMinOffcut] = useState(minOffcutMm)

  useEffect(() => { setName(draftName) }, [draftName])
  useEffect(() => { setNote(draftNote) }, [draftNote])
  useEffect(() => { setKerf(sawKerfMm) }, [sawKerfMm])
  useEffect(() => { setMinOffcut(minOffcutMm) }, [minOffcutMm])

  const metaDirty = name !== draftName || note !== draftNote || kerf !== sawKerfMm || minOffcut !== minOffcutMm

  const saveMeta = async () => {
    if (!name.trim()) return
    await onSaveMeta({ name: name.trim(), note: note.trim(), sawKerfMm: kerf, minOffcutMm: minOffcut })
  }

  return (
    <section className="panel p-5" data-testid="panel-batch">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-wood-900">批次排样</h2>
          <p className="mt-1 text-xs text-stone-500">排样只做演算不扣库存；确认时才一次扣板、回料、记账。</p>
        </div>
        <div className="flex items-center gap-2">
          {hasPlan ? (
            <span className={`rounded-full px-3 py-1 text-xs ${invalidated ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`} data-testid="plan-badge">
              {invalidated ? '旧排样已失效' : '排样有效'}
            </span>
          ) : null}
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-stone-600">批次名称</span>
          <input className="input-field py-1.5" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-stone-600">备注</span>
          <input className="input-field py-1.5" value={note} placeholder="用途、家具部件等" onChange={(event) => setNote(event.target.value)} />
        </label>
        <div className="flex items-end">
          <button type="button" className="secondary-button w-full md:w-auto" disabled={!metaDirty} onClick={() => void saveMeta()}>
            保存批次信息
          </button>
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <NumberInput label="锯路宽度 mm（参与占位）" value={kerf} step={0.5} onChange={setKerf} />
        <NumberInput label="余料最小回库边长 mm" value={minOffcut} onChange={setMinOffcut} />
      </div>

      {invalidated && staleReason ? (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" data-testid="plan-stale">
          <strong>旧排样失效：</strong>{staleReason}
        </div>
      ) : null}

      {rejectReasons.length > 0 ? (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" data-testid="plan-reject">
          <p className="font-semibold">整批拒绝，未动库存：</p>
          <ul className="mt-1.5 list-inside list-disc space-y-1">
            {rejectReasons.map((reason) => (
              <li key={`${reason.kind}-${reason.componentId}`}>{reason.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {confirmError ? (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="confirm-conflict">
          <strong>提交未成功：</strong>{confirmError}
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-wood-100 pt-4">
        <button
          type="button"
          className="primary-button"
          data-testid="run-plan"
          disabled={planning || componentCount === 0 || boardCount === 0}
          onClick={onPlan}
        >
          {planning ? '排样演算中…' : invalidated && hasPlan ? '重新排样' : '生成排样'}
        </button>
        <button
          type="button"
          className="secondary-button"
          data-testid="confirm-plan"
          disabled={confirming || !hasPlan || invalidated}
          onClick={onConfirm}
        >
          {confirming ? '确认提交中…' : '确认开料（扣板·回料·记账）'}
        </button>
        {componentCount === 0 || boardCount === 0 ? (
          <span className="text-xs text-stone-500">需先有在库板材和待加工构件</span>
        ) : null}
      </div>
    </section>
  )
}

/* ------------------------------ 排样结果 ------------------------------ */

function PlanPanel() {
  const draft = useCutStore((state) => state.draft)
  const plan = draft?.plan ?? null

  if (!plan) {
    return (
      <BlankPanel
        title="尚未排样"
        description="登记板材与构件后点击“生成排样”。排样成功可预览每块板的落位与余料，容量或纹向不符时会整批拒绝。"
      />
    )
  }

  const offcutCount = plan.boards.reduce((sum, board) => sum + board.offcuts.length, 0)
  const wasteArea = plan.boards.reduce((sum, board) => sum + board.wasteAreaMm2, 0)

  return (
    <section className="panel p-5" data-testid="panel-plan">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-wood-900">排样图</h2>
          <p className="mt-1 text-xs text-stone-500">
            占用 {plan.boards.length} 块板 · 回库余料 {offcutCount} 块 · 碎料不回库
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-lg bg-wood-50 px-3 py-1.5 text-wood-800">利用率 {plan.utilizationPct}%</span>
          <span className="rounded-lg bg-wood-50 px-3 py-1.5 text-wood-800">净用 {plan.usedAreaMm2.toLocaleString()} mm²</span>
          <span className="rounded-lg bg-stone-50 px-3 py-1.5 text-stone-600">碎料 {wasteArea.toLocaleString()} mm²</span>
        </div>
      </header>
      <div className="space-y-6">
        {plan.boards.map((usedBoard) => (
          <div key={usedBoard.boardId} className="overflow-x-auto rounded-xl border border-wood-100 bg-[#fbf8f2] p-3">
            <div className="min-w-[520px]">
              <PlanBoardSvg usedBoard={usedBoard} sawKerfMm={plan.sawKerfMm} />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ------------------------------ 开料流水 ------------------------------ */

interface RecordsPanelProps {
  records: ReturnType<typeof useCutStore.getState>['records']
}

function RecordsPanel({ records }: RecordsPanelProps) {
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set<string>())

  if (records.length === 0) return null

  const toggle = (id: string) => {
    setOpenIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <section className="panel p-5" data-testid="panel-records">
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-wood-900">开料记录</h2>
        <p className="mt-1 text-xs text-stone-500">确认时写入的不可变流水：扣减板材、回存余料、成品构件均可追溯。</p>
      </header>
      <ul className="space-y-3">
        {records.map((record) => {
          const open = openIds.has(record.id)
          return (
            <li key={record.id} className="rounded-xl border border-wood-100 bg-white">
              <button
                type="button"
                className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left text-sm"
                onClick={() => toggle(record.id)}
                data-testid="row-record"
              >
                <span className="font-medium text-wood-900">{record.batchName}</span>
                <span className="flex flex-wrap items-center gap-3 text-xs text-stone-500">
                  <span>{formatTime(record.confirmedAt)}</span>
                  <span className="rounded bg-stone-100 px-2 py-0.5">扣板 {record.consumedBoards.length}</span>
                  <span className="rounded bg-green-50 px-2 py-0.5 text-green-700">回料 {record.offcuts.length}</span>
                  <span className="rounded bg-wood-50 px-2 py-0.5 text-wood-700">成品 {record.totalPieces} 件</span>
                  <span className="text-wood-500">{open ? '收起 ▲' : '展开 ▼'}</span>
                </span>
              </button>
              {open ? (
                <div className="grid gap-4 border-t border-wood-100 px-4 py-4 text-xs text-stone-600 md:grid-cols-3">
                  <div>
                    <p className="mb-1.5 font-semibold text-stone-700">扣减板材</p>
                    <ul className="space-y-1">
                      {record.consumedBoards.map((board) => (
                        <li key={board.boardId}>{board.code} · {board.species} · {grainLabel[board.grain]} · {board.lengthMm}×{board.widthMm}×{board.thicknessMm}mm</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-1.5 font-semibold text-stone-700">回库余料</p>
                    {record.offcuts.length === 0 ? <p>无整块余料（零头作碎料）</p> : (
                      <ul className="space-y-1">
                        {record.offcuts.map((offcut) => (
                          <li key={offcut.boardId}>{offcut.code} · {offcut.lengthMm}×{offcut.widthMm}×{offcut.thicknessMm}mm（源自 {offcut.parentBoardId.slice(-6)}）</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <p className="mb-1.5 font-semibold text-stone-700">成品构件</p>
                    <ul className="space-y-1">
                      {record.components.map((component) => (
                        <li key={component.componentId}>
                          {component.name} × {component.qty} · {modeLabel[component.grainMode]} · {component.lengthMm}×{component.widthMm}×{component.thicknessMm}mm
                        </li>
                      ))}
                    </ul>
                    {record.note ? <p className="mt-2 text-stone-500">备注：{record.note}</p> : null}
                    <p className="mt-2 text-stone-400">流水号 {record.id} · 利用率 {record.utilizationPct}% · 锯路 {record.sawKerfMm}mm</p>
                  </div>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

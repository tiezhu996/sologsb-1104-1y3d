import { useEffect, useMemo, useRef, useState } from 'react'
import { BoardLayout } from '../components/cutting/BoardLayout'
import { RecordsPanel } from '../components/cutting/RecordsPanel'
import { StockPanel } from '../components/cutting/StockPanel'
import { BlankPanel } from '../components/common/BlankPanel'
import { useCuttingStore, type LayoutSnapshot } from '../stores/cuttingStore'
import type { PackResult } from '../utils/packing'
import { memberCutFingerprint, packBoards } from '../utils/packing'
import { subscribeCuttingMessages } from '../utils/cuttingEvents'

type TabKey = 'cutting' | 'stock' | 'records'

const DRAFT_STORAGE_KEY = 'gbmortise-cutting-draft-v1'

interface StoredDraft {
  qtyById: Record<string, number>
  note: string
}

function loadDraft(): StoredDraft {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StoredDraft
      return { qtyById: parsed.qtyById ?? {}, note: parsed.note ?? '' }
    }
  } catch {
    // 草稿损坏时从空草稿开始
  }
  return { qtyById: {}, note: '' }
}

export default function CuttingBench() {
  const boards = useCuttingStore((state) => state.boards)
  const members = useCuttingStore((state) => state.members)
  const joints = useCuttingStore((state) => state.joints)
  const loading = useCuttingStore((state) => state.loading)
  const submitting = useCuttingStore((state) => state.submitting)
  const loadAll = useCuttingStore((state) => state.loadAll)
  const reloadStock = useCuttingStore((state) => state.reloadStock)
  const confirmCut = useCuttingStore((state) => state.confirmCut)

  const [tab, setTab] = useState<TabKey>('cutting')
  const [qtyById, setQtyById] = useState<Record<string, number>>(() => loadDraft().qtyById)
  const [note, setNote] = useState<string>(() => loadDraft().note)
  const [packResult, setPackResult] = useState<PackResult | null>(null)
  const [snapshot, setSnapshot] = useState<LayoutSnapshot | null>(null)
  const [externalStale, setExternalStale] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const snapshotRef = useRef<LayoutSnapshot | null>(null)
  snapshotRef.current = snapshot

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // 草稿（件数、备注）本地留存，排样冲突后后到者仍保留草稿重排
  useEffect(() => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ qtyById, note }))
  }, [qtyById, note])

  // 跨页签：库存变动后刷新；另一页签确认开料后，作废引用同一批板的排样但保留草稿
  useEffect(() => subscribeCuttingMessages((message) => {
    if (message.type === 'stock-mutated') {
      void reloadStock()
      return
    }
    const current = snapshotRef.current
    if (current && message.type === 'cut-committed') {
      const touched = current.packedBoards.some((packed) => message.consumedBoardIds.includes(packed.boardId))
      if (touched) {
        setSnapshot(null)
        setPackResult(null)
        setExternalStale(`另一页签已用批号 ${message.batchNo} 开掉这批木料，本页签的排样已作废。件数草稿已保留，请重新排样。`)
      }
      void reloadStock()
    }
  }), [reloadStock])

  const jointNameById = useMemo(() => {
    const map = new Map(joints.map((joint) => [joint.id, joint.name]))
    return map
  }, [joints])

  const grouped = useMemo(() => {
    return joints
      .map((joint) => ({
        joint,
        members: members
          .filter((member) => member.jointTypeId === joint.id)
          .sort((a, b) => a.lengthMm - b.lengthMm),
      }))
      .filter((group) => group.members.length > 0)
  }, [joints, members])

  const selectedItems = useMemo(() => members
    .map((member) => ({ member, qty: qtyById[member.id] ?? 0 }))
    .filter((entry) => entry.qty > 0), [members, qtyById])

  const totalQty = selectedItems.reduce((sum, entry) => sum + entry.qty, 0)

  // 排样后若构件尺寸/纹向被修改，指纹不再匹配，旧排样失效
  const staleMembers = useMemo(() => {
    if (!snapshot) return [] as string[]
    return selectedItems
      .filter((entry) => snapshot.fingerprints[entry.member.id] !== memberCutFingerprint(entry.member))
      .map((entry) => entry.member.name)
  }, [snapshot, selectedItems])

  const updateQty = (memberId: string, qty: number) => {
    const safeQty = Math.max(0, Math.min(99, Math.floor(qty) || 0))
    setQtyById((current) => ({ ...current, [memberId]: safeQty }))
  }

  const runPacking = () => {
    if (selectedItems.length === 0) {
      setPackResult(null)
      setSnapshot(null)
      setFeedback({ kind: 'error', text: '请先勾选待加工构件并填写件数。' })
      return
    }
    const items = selectedItems.map((entry) => ({
      memberId: entry.member.id,
      memberName: entry.member.name,
      jointTypeId: entry.member.jointTypeId,
      grainDir: entry.member.grainDir,
      lengthMm: entry.member.lengthMm,
      widthMm: entry.member.widthMm,
      thicknessMm: entry.member.thicknessMm,
      qty: entry.qty,
      cutRev: entry.member.cutRev ?? 1,
    }))
    const result = packBoards(items, boards)
    setPackResult(result)
    setExternalStale(null)
    setFeedback(null)
    if (result.ok) {
      const fingerprints: Record<string, string> = {}
      for (const entry of selectedItems) {
        fingerprints[entry.member.id] = memberCutFingerprint(entry.member)
      }
      setSnapshot({ packedBoards: result.packedBoards, fingerprints, packedAt: Date.now() })
    } else {
      setSnapshot(null)
    }
  }

  const handleConfirm = async () => {
    if (!snapshot) return
    const outcome = await confirmCut(snapshot, note)
    await reloadStock()
    if (outcome.ok) {
      setFeedback({ kind: 'ok', text: `开料成功，批号 ${outcome.batchNo}。板材已扣减、余料已回库，开料记录已留档。` })
      setSnapshot(null)
      setPackResult(null)
      setQtyById({})
      setNote('')
      setExternalStale(null)
    } else {
      setFeedback({ kind: 'error', text: outcome.message })
      // 后到者：保留草稿，作废当前排样等待重排
      if (outcome.reason === 'board-changed' || outcome.reason === 'member-changed') {
        setSnapshot(null)
        setPackResult(null)
      }
    }
  }

  if (loading && boards.length === 0 && members.length === 0) {
    return <div className="py-16 text-center text-sm text-stone-500">正在读取木料库存…</div>
  }

  const stockSummary = [
    { label: '顺纹整板', value: boards.filter((b) => b.grainDir === '顺纹' && !b.isRemnant).length },
    { label: '横纹整板', value: boards.filter((b) => b.grainDir === '横纹' && !b.isRemnant).length },
    { label: '回库余料', value: boards.filter((b) => b.isRemnant).length },
  ]

  return (
    <div className="space-y-6" data-testid="cutting-bench">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-wood-900 sm:text-3xl">开料台</h1>
        <p className="max-w-4xl text-sm leading-6 text-stone-600">
          从现有木料给待加工构件排样：顺纹件只开顺纹板且长边沿纹，横纹件上横纹板（可旋转 90°），构件不越界、不重叠。
          容量不够或纹向不符时<strong className="text-rose-700">整批拒绝</strong>；构件尺寸或纹向一改，旧排样立即失效。
          确认后一次性扣减板材、回存切剩余料并留下开料记录；两个页签同时开同一批木料只成功一次，后到者保留草稿重排。
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {stockSummary.map((item) => (
            <span key={item.label} className="rounded-full border border-wood-100 bg-white px-3 py-1 text-xs text-wood-700">
              {item.label} <strong className="ml-1">{item.value}</strong> 张
            </span>
          ))}
        </div>
      </header>

      <nav className="flex gap-2" aria-label="开料台页签">
        {([
          { key: 'cutting', label: '排样开料' },
          { key: 'stock', label: '木料库存' },
          { key: 'records', label: '开料记录' },
        ] as const).map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              tab === item.key ? 'bg-wood-700 text-white shadow-sm' : 'border border-wood-100 bg-white text-wood-700 hover:bg-wood-50'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === 'stock' ? <StockPanel /> : null}
      {tab === 'records' ? <RecordsPanel /> : null}

      {tab === 'cutting' ? (
        <div className="space-y-6">
          {externalStale ? (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert">
              {externalStale}
            </div>
          ) : null}
          {feedback ? (
            <div
              className={`rounded-xl border px-4 py-3 text-sm ${
                feedback.kind === 'ok' ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-rose-300 bg-rose-50 text-rose-900'
              }`}
              role="status"
            >
              {feedback.text}
            </div>
          ) : null}

          <section className="panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-wood-100 bg-wood-50/60 px-5 py-3">
              <h2 className="font-semibold text-wood-900">待加工构件</h2>
              <div className="flex items-center gap-3">
                <span className="text-xs text-stone-500">已选 {totalQty} 件</span>
                <button type="button" className="secondary-button" onClick={() => setQtyById({})}>清空件数</button>
                <button type="button" className="primary-button" onClick={runPacking}>自动排样</button>
              </div>
            </div>
            <div className="divide-y divide-stone-100">
              {grouped.map((group) => (
                <div key={group.joint.id} className="px-5 py-4">
                  <h3 className="text-sm font-semibold text-wood-700">{group.joint.name}</h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {group.members.map((member) => (
                      <label
                        key={member.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"
                      >
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <strong className="truncate text-stone-900">{member.name}</strong>
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                              member.grainDir === '顺纹' ? 'bg-amber-50 text-amber-800' : 'bg-stone-100 text-stone-600'
                            }`}>{member.grainDir}</span>
                          </span>
                          <span className="mt-0.5 block text-[11px] text-stone-500">
                            {member.lengthMm}×{member.widthMm}×{member.thicknessMm}mm
                            {jointNameById.get(member.jointTypeId) ? ` · ${jointNameById.get(member.jointTypeId)}` : ''}
                          </span>
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={99}
                          aria-label={`${member.name}件数`}
                          className="w-16 rounded-lg border border-wood-100 px-2 py-1.5 text-center text-sm outline-none focus:border-wood-500"
                          value={qtyById[member.id] ?? 0}
                          onChange={(event) => updateQty(member.id, Number(event.target.value))}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {packResult && !packResult.ok ? (
            <section className="rounded-2xl border border-rose-200 bg-rose-50/70 p-5">
              <h2 className="font-semibold text-rose-900">整批拒绝 · 未占用任何木料</h2>
              <ul className="mt-3 space-y-2 text-sm text-rose-900">
                {packResult.rejections.map((rejection) => (
                  <li key={`${rejection.memberId}-${rejection.code}`} className="flex gap-2">
                    <span aria-hidden className="mt-0.5">✕</span>
                    <span>{rejection.message}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-rose-700">请补充对应纹向 / 规格的板材，或调整构件尺寸后重新排样。</p>
            </section>
          ) : null}

          {snapshot && packResult?.ok ? (
            <section className="panel p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-semibold text-wood-900">排样结果</h2>
                <span className="text-xs text-stone-500">占用 {snapshot.packedBoards.length} 张板 · {totalQty} 件</span>
              </div>
              {staleMembers.length > 0 ? (
                <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert">
                  构件 {staleMembers.join('、')} 的尺寸或纹向已修改，旧排样失效，请重新排样后再确认。
                </div>
              ) : null}
              <div className="mt-4 grid gap-5 xl:grid-cols-2">
                {snapshot.packedBoards.map((packed) => (
                  <BoardLayout key={packed.boardId} packed={packed} />
                ))}
              </div>
              <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-wood-100 pt-4">
                <label className="max-w-xs flex-1 space-y-1 text-xs text-stone-600">
                  开料备注（可选）
                  <input className="input-field" value={note} onChange={(event) => setNote(event.target.value)} placeholder="如：明式圈椅一批" />
                </label>
                <button
                  type="button"
                  className="primary-button"
                  disabled={submitting || staleMembers.length > 0}
                  onClick={() => void handleConfirm()}
                >
                  {submitting ? '提交中…' : '确认开料：扣减板材并回存余料'}
                </button>
                <button type="button" className="secondary-button" onClick={runPacking}>重新排样</button>
              </div>
            </section>
          ) : null}

          {!packResult ? (
            <BlankPanel
              title="尚未排样"
              description="填写各构件件数后点击“自动排样”。排样只在本地演算，不扣库存；点“确认开料”才会一次性扣减板材、回存余料。"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

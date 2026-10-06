import { create } from 'zustand'
import type {
  BoardGrain,
  BoardStock,
  CutBatch,
  CutComponent,
  CutPlan,
  CutRecord,
  GrainRequirement,
} from '../types/cutting'
import { db, ensureSeedData } from '../utils/db'
import { checkPlanStaleness, packCutting, type PackResult, type RejectReason } from '../utils/packing'
import { postCuttingMessage } from '../utils/cuttingBus'

interface LocksNavigator {
  locks?: {
    request: <T>(name: string, options: { mode: 'exclusive' }, callback: () => T | Promise<T>) => Promise<T>
  }
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function nextCode(existing: BoardStock[]): string {
  let max = 0
  for (const board of existing) {
    const match = board.code.match(/^YL-(\d+)$/)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `YL-${String(max + 1).padStart(3, '0')}`
}

/** 取当前唯一的开料草稿（updatedAt 最新的 draft 批次） */
async function loadLatestDraft(): Promise<CutBatch | null> {
  const drafts = await db.cutBatches.where('status').equals('draft').sortBy('updatedAt')
  return drafts[drafts.length - 1] ?? null
}

/** 同批木料按板材 id 排序后命名锁，保证两个页签对同一批料串行确认 */
async function withBoardLocks<T>(boardIds: string[], task: () => Promise<T>): Promise<T> {
  const sortedIds = [...new Set(boardIds)].sort()
  const navigatorWithLocks = navigator as unknown as LocksNavigator
  const runWithLockAt = (index: number): Promise<T> => {
    if (index >= sortedIds.length) return task()
    const lockName = `gbmortise-cut-board:${sortedIds[index]}`
    if (navigatorWithLocks.locks?.request) {
      return navigatorWithLocks.locks.request(lockName, { mode: 'exclusive' }, () => runWithLockAt(index + 1))
    }
    // 不支持 Web Locks 的环境退化为直接执行，事务内 rev/status 校验仍保证正确性
    return runWithLockAt(index + 1)
  }
  return runWithLockAt(0)
}

export class ConfirmConflictError extends Error {
  reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'ConfirmConflictError'
    this.reason = reason
  }
}

interface CutState {
  boards: BoardStock[]
  components: CutComponent[]
  draft: CutBatch | null
  records: CutRecord[]
  loading: boolean
  loadAll: () => Promise<void>
  // 板材台账
  addBoard: (draft: BoardDraft) => Promise<BoardStock>
  updateBoard: (id: string, draft: Partial<BoardDraft>) => Promise<void>
  // 构件
  addComponent: (draft: ComponentDraft) => Promise<CutComponent>
  updateComponent: (id: string, draft: Partial<ComponentDraft>) => Promise<void>
  removeComponent: (id: string) => Promise<void>
  // 批次与排样
  saveDraftMeta: (meta: { name: string; note: string; sawKerfMm: number; minOffcutMm: number }) => Promise<void>
  generatePlan: () => Promise<{ result: PackResult }>
  revalidateDraft: () => Promise<void>
  syncRemote: () => Promise<void>
  confirmPlan: () => Promise<{ recordId: string; record: CutRecord }>
}

export interface BoardDraft {
  code?: string
  species: string
  grain: BoardGrain
  lengthMm: number
  widthMm: number
  thicknessMm: number
}

export interface ComponentDraft {
  name: string
  grainMode: GrainRequirement
  lengthMm: number
  widthMm: number
  thicknessMm: number
  qty: number
}

const DEFAULT_DRAFT: Pick<CutBatch, 'name' | 'note' | 'sawKerfMm' | 'minOffcutMm'> = {
  name: '新开料批',
  note: '',
  sawKerfMm: 2,
  minOffcutMm: 120,
}

export const useCutStore = create<CutState>((set, get) => ({
  boards: [],
  components: [],
  draft: null,
  records: [],
  loading: false,

  loadAll: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      await ensureSeedData()
      const [boards, components, draft, records] = await Promise.all([
        db.boards.toCollection().sortBy('createdAt'),
        db.cutComponents.toCollection().sortBy('createdAt'),
        loadLatestDraft(),
        db.cutRecords.orderBy('confirmedAt').reverse().toArray(),
      ])
      set({ boards, components, draft, records })
      await get().revalidateDraft()
    } finally {
      set({ loading: false })
    }
  },

  addBoard: async (draft) => {
    const now = Date.now()
    const board: BoardStock = {
      id: createId('board'),
      code: draft.code?.trim() || nextCode(get().boards),
      species: draft.species.trim() || '未注明木种',
      grain: draft.grain,
      lengthMm: draft.lengthMm,
      widthMm: draft.widthMm,
      thicknessMm: draft.thicknessMm,
      status: 'in_stock',
      source: 'purchase',
      rev: 1,
      createdAt: now,
    }
    await db.boards.add(board)
    set((state) => ({ boards: [...state.boards, board] }))
    postCuttingMessage({ type: 'boards-changed' })
    return board
  },

  updateBoard: async (id, draft) => {
    const existing = get().boards.find((board) => board.id === id)
    if (!existing) return
    await db.transaction('rw', db.boards, db.cutBatches, async () => {
      await db.boards.update(id, { ...draft, rev: existing.rev + 1 })
      // 正在排样中占用了该板时，改尺寸等于旧排样失效
      const currentDraft = await loadLatestDraft()
      if (currentDraft?.plan && !currentDraft.invalidated) {
        const touches = currentDraft.plan.boardRefs.some((ref) => ref.boardId === id)
        if (touches) {
          await db.cutBatches.update(currentDraft.id, {
            invalidated: true,
            staleReason: '排样占用的板材尺寸已修改，旧排样失效，请重新排样。',
            rev: currentDraft.rev + 1,
            updatedAt: Date.now(),
          })
        }
      }
    })
    set((state) => ({
      boards: state.boards.map((board) => (board.id === id ? { ...board, ...draft, rev: board.rev + 1 } : board)),
      draft: state.draft && state.draft.plan?.boardRefs.some((ref) => ref.boardId === id)
        ? { ...state.draft, invalidated: true, staleReason: '排样占用的板材尺寸已修改，旧排样失效，请重新排样。' }
        : state.draft,
    }))
    postCuttingMessage({ type: 'boards-changed' })
  },

  addComponent: async (draft) => {
    const now = Date.now()
    const component: CutComponent = { id: createId('cut-comp'), ...draft, rev: 1, createdAt: now }
    await db.cutComponents.add(component)
    set((state) => ({ components: [...state.components, component] }))
    postCuttingMessage({ type: 'components-changed' })
    return component
  },

  updateComponent: async (id, draft) => {
    const existing = get().components.find((component) => component.id === id)
    if (!existing) return
    await db.transaction('rw', db.cutComponents, db.cutBatches, async () => {
      await db.cutComponents.update(id, { ...draft, rev: existing.rev + 1 })
      const currentDraft = await loadLatestDraft()
      if (currentDraft?.plan && currentDraft.plan.componentRefs.some((ref) => ref.componentId === id) && !currentDraft.invalidated) {
        const label = draft.name ?? existing.name
        const shapeChanged = draft.lengthMm !== undefined || draft.widthMm !== undefined
          || draft.grainMode !== undefined || draft.thicknessMm !== undefined
        const reason = shapeChanged
          ? `构件「${label}」的尺寸或纹向已修改，旧排样失效，请重新排样。`
          : `构件「${label}」的数量已修改，旧排样失效，请重新排样。`
        await db.cutBatches.update(currentDraft.id, {
          invalidated: true,
          staleReason: reason,
          rev: currentDraft.rev + 1,
          updatedAt: Date.now(),
        })
      }
    })
    set((state) => {
      const inPlan = state.draft?.plan?.componentRefs.some((ref) => ref.componentId === id) ?? false
      return {
        components: state.components.map((component) => (
          component.id === id ? { ...component, ...draft, rev: component.rev + 1 } : component
        )),
        draft: inPlan
          ? {
              ...state.draft!,
              invalidated: true,
              staleReason: `构件「${draft.name ?? existing.name}」的尺寸或纹向已修改，旧排样失效，请重新排样。`,
            }
          : state.draft,
      }
    })
    postCuttingMessage({ type: 'components-changed' })
  },

  removeComponent: async (id) => {
    await db.transaction('rw', db.cutComponents, db.cutBatches, async () => {
      await db.cutComponents.delete(id)
      const currentDraft = await loadLatestDraft()
      if (currentDraft?.plan && currentDraft.plan.componentRefs.some((ref) => ref.componentId === id) && !currentDraft.invalidated) {
        await db.cutBatches.update(currentDraft.id, {
          invalidated: true,
          staleReason: '排样中的构件已被删除，旧排样失效，请重新排样。',
          rev: currentDraft.rev + 1,
          updatedAt: Date.now(),
        })
      }
    })
    set((state) => ({
      components: state.components.filter((component) => component.id !== id),
      draft: state.draft?.plan?.componentRefs.some((ref) => ref.componentId === id)
        ? { ...state.draft, invalidated: true, staleReason: '排样中的构件已被删除，旧排样失效，请重新排样。' }
        : state.draft,
    }))
    postCuttingMessage({ type: 'components-changed' })
  },

  saveDraftMeta: async (meta) => {
    const existing = get().draft
    const now = Date.now()
    if (existing) {
      // 锯路或最小余料变化会改变占位与回料账，旧排样一并失效
      const cuttingRuleChanged = existing.plan !== null
        && (meta.sawKerfMm !== existing.sawKerfMm || meta.minOffcutMm !== existing.minOffcutMm)
      const updated: CutBatch = {
        ...existing,
        ...meta,
        invalidated: existing.invalidated || cuttingRuleChanged,
        staleReason: cuttingRuleChanged ? '锯路或最小余料尺寸已修改，旧排样失效，请重新排样。' : existing.staleReason,
        rev: existing.rev + 1,
        updatedAt: now,
      }
      await db.cutBatches.update(existing.id, {
        ...meta,
        invalidated: updated.invalidated,
        staleReason: updated.staleReason,
        rev: updated.rev,
        updatedAt: now,
      })
      set({ draft: updated })
      return
    }
    const draft: CutBatch = {
      id: createId('cut-batch'),
      ...DEFAULT_DRAFT,
      ...meta,
      status: 'draft',
      plan: null,
      invalidated: false,
      rev: 1,
      createdAt: now,
      updatedAt: now,
    }
    await db.cutBatches.add(draft)
    set({ draft })
  },

  generatePlan: async () => {
    const state = get()
    let draft = state.draft
    const now = Date.now()
    if (!draft) {
      draft = {
        id: createId('cut-batch'),
        ...DEFAULT_DRAFT,
        status: 'draft',
        plan: null,
        invalidated: false,
        rev: 1,
        createdAt: now,
        updatedAt: now,
      }
      await db.cutBatches.add(draft)
    }

    const inStockBoards = state.boards
      .filter((board) => board.status === 'in_stock')
      .map((board) => ({
        id: board.id,
        code: board.code,
        species: board.species,
        grain: board.grain,
        lengthMm: board.lengthMm,
        widthMm: board.widthMm,
        thicknessMm: board.thicknessMm,
      }))

    const result = packCutting({
      components: state.components,
      boards: inStockBoards,
      sawKerfMm: draft.sawKerfMm,
      minOffcutMm: draft.minOffcutMm,
    })

    if (result.ok) {
      const boardMap = new Map(state.boards.map((board) => [board.id, board]))
      const plan: CutPlan = {
        plannedAt: now,
        sawKerfMm: draft.sawKerfMm,
        minOffcutMm: draft.minOffcutMm,
        boards: result.boards.map((used) => ({ ...used, rev: boardMap.get(used.boardId)?.rev ?? 1 })),
        componentRefs: state.components
          .filter((component) => component.qty > 0)
          .map((component) => ({ componentId: component.id, rev: component.rev, qty: component.qty })),
        boardRefs: result.boards.map((used) => ({ boardId: used.boardId, rev: boardMap.get(used.boardId)?.rev ?? 1 })),
        usedAreaMm2: result.usedAreaMm2,
        boardAreaMm2: result.boardAreaMm2,
        utilizationPct: result.utilizationPct,
      }
      const updated: CutBatch = {
        ...draft,
        plan,
        invalidated: false,
        staleReason: undefined,
        rev: draft.rev + 1,
        updatedAt: now,
      }
      await db.cutBatches.update(draft.id, {
        plan,
        invalidated: false,
        staleReason: undefined,
        rev: updated.rev,
        updatedAt: now,
      })
      set({ draft: updated })
    }
    return { result }
  },

  revalidateDraft: async () => {
    const state = get()
    const draft = state.draft
    if (!draft?.plan || draft.status !== 'draft') return
    const stale = checkPlanStaleness(draft.plan, state.components, state.boards)
    if (stale.stale && !draft.invalidated) {
      const updated: CutBatch = { ...draft, invalidated: true, staleReason: stale.reason, rev: draft.rev + 1, updatedAt: Date.now() }
      await db.cutBatches.update(draft.id, { invalidated: true, staleReason: stale.reason, rev: updated.rev, updatedAt: updated.updatedAt })
      set({ draft: updated })
    }
  },

  /**
   * 跨页签同步：其他页签改动库存/构件或确认开料后调用。
   * 若本页签的草稿所用板已被对方确认扣减，则把草稿克隆为新的草稿行
   * （旧批次已在对方页签转为 confirmed），保留草稿并标记失效、等待重排。
   */
  syncRemote: async () => {
    const [boards, components, records, persistedDraft] = await Promise.all([
      db.boards.toCollection().sortBy('createdAt'),
      db.cutComponents.toCollection().sortBy('createdAt'),
      db.cutRecords.orderBy('confirmedAt').reverse().toArray(),
      loadLatestDraft(),
    ])
    const localDraft = get().draft

    if (localDraft && persistedDraft?.id !== localDraft.id) {
      // 本地草稿在库里已不是草稿（被另一页签确认），保留草稿副本并标记失效
      const stale = checkPlanStaleness(
        localDraft.plan ?? { componentRefs: [], boardRefs: [] },
        components,
        boards,
      )
      const now = Date.now()
      const retained: CutBatch = {
        ...localDraft,
        id: createId('cut-batch'),
        status: 'draft',
        invalidated: true,
        staleReason: stale.stale && stale.reason
          ? stale.reason
          : '同批木料已被另一页签确认开料，本批未提交，草稿保留，请重新排样。',
        confirmedAt: undefined,
        recordId: undefined,
        rev: 1,
        createdAt: now,
        updatedAt: now,
      }
      await db.cutBatches.add(retained)
      set({ boards, components, records, draft: retained })
      return
    }

    set({ boards, components, records, draft: persistedDraft ?? localDraft })
    await get().revalidateDraft()
  },

  confirmPlan: async () => {
    const state = get()
    const draft = state.draft
    if (!draft?.plan || draft.invalidated) {
      throw new ConfirmConflictError('排样已失效，请重新排样后再确认。')
    }
    const plan = draft.plan
    const boardIds = plan.boardRefs.map((ref) => ref.boardId)

    return withBoardLocks(boardIds, async () => {
      const now = Date.now()
      const recordId = createId('cut-rec')
      return db.transaction('rw', [db.boards, db.cutBatches, db.cutComponents, db.cutRecords], async () => {
        // 事务内二次校验：板必须仍在库且 rev 未变、批次仍是草稿
        const liveBoards = await db.boards.where('id').anyOf(boardIds).toArray()
        const liveBoardMap = new Map(liveBoards.map((board) => [board.id, board]))
        for (const ref of plan.boardRefs) {
          const board = liveBoardMap.get(ref.boardId)
          if (!board) throw new ConfirmConflictError('排样占用的板材已被删除，请保留草稿并重新排样。')
          if (board.status !== 'in_stock') {
            throw new ConfirmConflictError(`板材 ${board.code} 已被另一页签的开料批次扣减，本批未提交，草稿保留，请重新排样。`)
          }
          if (board.rev !== ref.rev) {
            throw new ConfirmConflictError(`板材 ${board.code} 在排样后被修改，本批未提交，草稿保留，请重新排样。`)
          }
        }
        const liveComponents = await db.cutComponents.toArray()
        const liveComponentMap = new Map(liveComponents.map((component) => [component.id, component]))
        for (const ref of plan.componentRefs) {
          const component = liveComponentMap.get(ref.componentId)
          if (!component) throw new ConfirmConflictError('排样中的构件已被删除，请重新排样。')
          if (component.rev !== ref.rev || component.qty !== ref.qty) {
            throw new ConfirmConflictError('构件尺寸、纹向或数量在排样后被修改，请重新排样。')
          }
        }
        const liveDraft = await db.cutBatches.get(draft.id)
        if (!liveDraft || liveDraft.status !== 'draft' || liveDraft.rev !== draft.rev) {
          throw new ConfirmConflictError('该批次已被确认或已变动，请重新排样。')
        }

        // 1) 扣减整板
        const consumedBoardIds = new Set(boardIds)
        await db.boards.bulkPut(liveBoards.map((board) => ({ ...board, status: 'consumed' as const })))

        // 2) 余料回库（排样自由矩形中达最小尺寸的整块）
        const newOffcuts: BoardStock[] = []
        for (const usedBoard of plan.boards) {
          const parent = liveBoardMap.get(usedBoard.boardId)!
          usedBoard.offcuts.forEach((offcut, index) => {
            newOffcuts.push({
              id: createId('board'),
              code: `${parent.code}-Y${index + 1}`,
              species: parent.species,
              grain: parent.grain,
              lengthMm: offcut.lengthMm,
              widthMm: offcut.widthMm,
              thicknessMm: parent.thicknessMm,
              status: 'in_stock',
              source: 'offcut',
              parentBoardId: parent.id,
              batchId: draft.id,
              rev: 1,
              createdAt: now,
            })
          })
        }
        if (newOffcuts.length > 0) await db.boards.bulkAdd(newOffcuts)

        // 3) 开料流水（不可变台账）
        const record: CutRecord = {
          id: recordId,
          batchId: draft.id,
          batchName: draft.name,
          note: draft.note,
          confirmedAt: now,
          consumedBoards: plan.boards.map((used) => ({
            boardId: used.boardId,
            code: used.code,
            species: used.species,
            grain: used.grain,
            lengthMm: used.lengthMm,
            widthMm: used.widthMm,
            thicknessMm: used.thicknessMm,
          })),
          offcuts: newOffcuts.map((board) => ({
            boardId: board.id,
            code: board.code,
            species: board.species,
            grain: board.grain,
            lengthMm: board.lengthMm,
            widthMm: board.widthMm,
            thicknessMm: board.thicknessMm,
            parentBoardId: board.parentBoardId!,
          })),
          components: plan.componentRefs.map((ref) => {
            const component = liveComponentMap.get(ref.componentId)!
            return {
              componentId: component.id,
              name: component.name,
              grainMode: component.grainMode,
              lengthMm: component.lengthMm,
              widthMm: component.widthMm,
              thicknessMm: component.thicknessMm,
              qty: component.qty,
            }
          }),
          totalPieces: plan.componentRefs.reduce((sum, ref) => sum + ref.qty, 0),
          sawKerfMm: plan.sawKerfMm,
          utilizationPct: plan.utilizationPct,
        }
        await db.cutRecords.add(record)

        // 4) 批次转确认
        const confirmed: CutBatch = {
          ...draft,
          status: 'confirmed',
          invalidated: false,
          staleReason: undefined,
          confirmedAt: now,
          recordId,
          rev: draft.rev + 1,
          updatedAt: now,
        }
        await db.cutBatches.put(confirmed)

        const refreshedBoards = await db.boards.toCollection().sortBy('createdAt')
        const refreshedRecords = await db.cutRecords.toCollection().reverse().sortBy('confirmedAt')
        set({ boards: refreshedBoards, records: refreshedRecords, draft: null })
        postCuttingMessage({ type: 'batch-confirmed', batchId: draft.id, recordId, at: now })
        return { recordId, record }
      })
    })
  },
}))

export type { RejectReason }

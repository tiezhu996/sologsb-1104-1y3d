import { create } from 'zustand'
import type { Board, CutRecord, PackedBoard } from '../types/board'
import type { JointType } from '../types/jointType'
import type { Member } from '../types/member'
import { db, ensureSeedData } from '../utils/db'
import { memberCutFingerprint } from '../utils/packing'
import { postCuttingMessage } from '../utils/cuttingEvents'

export interface LayoutSnapshot {
  packedBoards: PackedBoard[]
  /** 排样时各构件的指纹，确认前必须仍与当前构件一致 */
  fingerprints: Record<string, string>
  packedAt: number
}

export interface BoardDraft {
  code: string
  grainDir: Member['grainDir']
  lengthMm: number
  widthMm: number
  thicknessMm: number
  note: string
}

export type ConfirmOutcome =
  | { ok: true; batchNo: string; record: CutRecord }
  | {
      ok: false
      reason: 'board-changed' | 'member-changed'
      boardCodes?: string[]
      memberNames?: string[]
      message: string
    }

interface CuttingState {
  boards: Board[]
  members: Member[]
  joints: JointType[]
  records: CutRecord[]
  loading: boolean
  submitting: boolean
  loadAll: () => Promise<void>
  reloadStock: () => Promise<void>
  addBoard: (draft: BoardDraft) => Promise<Board>
  deleteBoard: (boardId: string) => Promise<void>
  confirmCut: (snapshot: LayoutSnapshot, note?: string) => Promise<ConfirmOutcome>
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * 事务级提交：在单个 Dexie 读写事务内完成
 * 板材存在性/尺寸校验 → 构件指纹校验 → 扣减板材 → 回存余料 → 写开料记录。
 * 两个页签并发提交时，Dexie 对同表的读写事务串行执行：
 * 后到者读到的引用板材已被先到者删除，整笔回滚，不扣任何料。
 */
export async function commitCut(snapshot: LayoutSnapshot, note?: string): Promise<ConfirmOutcome> {
  return await db.transaction('rw', [db.boards, db.cutRecords, db.members], async (tx): Promise<ConfirmOutcome> => {
    const boardIds = snapshot.packedBoards.map((packed) => packed.boardId)
    const currentBoards = await tx.table<Board, string>('boards').where('id').anyOf(boardIds).toArray()
    const byId = new Map(currentBoards.map((board) => [board.id, board]))

    // 并发守卫：引用的每张板必须仍存在且料面与排样时一致（同一批木料只允许成功一次）
    const changedCodes: string[] = []
    for (const packed of snapshot.packedBoards) {
      const board = byId.get(packed.boardId)
      if (!board) {
        changedCodes.push(packed.boardCode)
        continue
      }
      const sameSurface = board.lengthMm === packed.lengthMm
        && board.widthMm === packed.widthMm
        && board.thicknessMm === packed.thicknessMm
        && board.grainDir === packed.grainDir
      if (!sameSurface) changedCodes.push(packed.boardCode)
    }
    if (changedCodes.length > 0) {
      return {
        ok: false,
        reason: 'board-changed',
        boardCodes: changedCodes,
        message: `木料 ${changedCodes.join('、')} 已被另一页签开料或发生变动，本次提交未扣减任何板材。草稿已保留，请重新排样。`,
      }
    }

    // 构件守卫：尺寸或纹向被改过则指纹不符，排样已失效
    const memberIds = [...new Set(snapshot.packedBoards.flatMap((packed) =>
      packed.placements.map((placement) => placement.memberId),
    ))]
    const currentMembers = await tx.table<Member, string>('members').where('id').anyOf(memberIds).toArray()
    const memberById = new Map(currentMembers.map((member) => [member.id, member]))
    const changedMembers: string[] = []
    for (const memberId of memberIds) {
      const member = memberById.get(memberId)
      if (!member) {
        changedMembers.push(memberId)
        continue
      }
      if (snapshot.fingerprints[memberId] !== memberCutFingerprint(member)) {
        changedMembers.push(member.name)
      }
    }
    if (changedMembers.length > 0) {
      return {
        ok: false,
        reason: 'member-changed',
        memberNames: changedMembers,
        message: `构件 ${changedMembers.join('、')} 的尺寸或纹向已修改，旧排样失效。本次提交未扣减任何板材，请重新排样。`,
      }
    }

    // 一次扣减板材 + 回存余料 + 写开料记录
    const records = await tx.table<CutRecord, string>('cutRecords').toCollection().count()
    const today = new Date()
    const datePart = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
    const batchNo = `KL${datePart}-${String(records + 1).padStart(3, '0')}`

    const consumedBoards: CutRecord['consumedBoards'] = []
    const returnedRemnants: CutRecord['returnedRemnants'] = []
    const remnantsToAdd: Board[] = []
    let memberCount = 0
    let wasteAreaMm2 = 0

    for (const packed of snapshot.packedBoards) {
      const source = byId.get(packed.boardId)!
      consumedBoards.push({
        boardId: source.id,
        boardCode: source.code,
        lengthMm: source.lengthMm,
        widthMm: source.widthMm,
        thicknessMm: source.thicknessMm,
        grainDir: source.grainDir,
      })
      memberCount += packed.placements.length
      wasteAreaMm2 += packed.wasteAreaMm2

      packed.remnants.forEach((remnant, index) => {
        // 回库余料统一以纹向（x 轴、长边）记长度
        const lengthMm = Math.max(remnant.wMm, remnant.hMm)
        const widthMm = Math.min(remnant.wMm, remnant.hMm)
        const remnantBoard: Board = {
          id: createId('board'),
          code: `${source.code}-Y${String(index + 1).padStart(2, '0')}`,
          grainDir: source.grainDir,
          lengthMm,
          widthMm,
          thicknessMm: source.thicknessMm,
          isRemnant: true,
          sourceBoardId: source.id,
          createdAt: Date.now() + index,
        }
        remnantsToAdd.push(remnantBoard)
        returnedRemnants.push({
          boardId: remnantBoard.id,
          boardCode: remnantBoard.code,
          lengthMm,
          widthMm,
          thicknessMm: remnantBoard.thicknessMm,
          grainDir: source.grainDir,
          sourceBoardId: source.id,
        })
      })
    }

    const placements = snapshot.packedBoards.flatMap((packed) =>
      packed.placements.map((placement) => ({
        memberId: placement.memberId,
        memberName: placement.memberName,
        grainDir: placement.grainDir,
        boardCode: packed.boardCode,
        lengthMm: placement.rotated ? placement.hMm : placement.wMm,
        widthMm: placement.rotated ? placement.wMm : placement.hMm,
        rotated: placement.rotated,
      })),
    )

    const record: CutRecord = {
      id: createId('cut'),
      batchNo,
      cutAt: Date.now(),
      memberCount,
      placements,
      consumedBoards,
      returnedRemnants,
      wasteAreaMm2,
      note: note?.trim() || undefined,
    }

    await tx.table<Board, string>('boards').bulkDelete(boardIds)
    await tx.table<Board, string>('boards').bulkAdd(remnantsToAdd)
    await tx.table<CutRecord, string>('cutRecords').add(record)

    postCuttingMessage({ type: 'cut-committed', consumedBoardIds: boardIds, batchNo, at: Date.now() })
    return { ok: true, batchNo, record }
  })
}

export const useCuttingStore = create<CuttingState>((set, get) => ({
  boards: [],
  members: [],
  joints: [],
  records: [],
  loading: false,
  submitting: false,

  loadAll: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      await ensureSeedData()
      const [boards, members, joints, records] = await Promise.all([
        db.boards.orderBy('createdAt').toArray(),
        db.members.toArray(),
        db.joints.toArray(),
        db.cutRecords.orderBy('cutAt').reverse().toArray(),
      ])
      set({ boards, members, joints, records })
    } finally {
      set({ loading: false })
    }
  },

  reloadStock: async () => {
    const [boards, members, joints, records] = await Promise.all([
      db.boards.orderBy('createdAt').toArray(),
      db.members.toArray(),
      db.joints.toArray(),
      db.cutRecords.orderBy('cutAt').reverse().toArray(),
    ])
    set({ boards, members, joints, records })
  },

  addBoard: async (draft) => {
    const board: Board = {
      id: createId('board'),
      code: draft.code.trim(),
      grainDir: draft.grainDir,
      lengthMm: draft.lengthMm,
      widthMm: draft.widthMm,
      thicknessMm: draft.thicknessMm,
      isRemnant: false,
      createdAt: Date.now(),
      note: draft.note.trim() || undefined,
    }
    await db.boards.add(board)
    set((state) => ({ boards: [...state.boards, board] }))
    postCuttingMessage({ type: 'stock-mutated', at: Date.now() })
    return board
  },

  deleteBoard: async (boardId) => {
    await db.boards.delete(boardId)
    set((state) => ({ boards: state.boards.filter((board) => board.id !== boardId) }))
    postCuttingMessage({ type: 'stock-mutated', at: Date.now() })
  },

  confirmCut: async (snapshot, note) => {
    if (get().submitting) {
      return { ok: false, reason: 'board-changed', message: '本页签已有一笔开料正在提交，请稍候。' }
    }
    set({ submitting: true })
    try {
      return await commitCut(snapshot, note)
    } finally {
      set({ submitting: false })
    }
  },
}))

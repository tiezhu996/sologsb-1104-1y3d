import type { Board, PackedBoard, PackedPlacement } from '../types/board'
import type { Member } from '../types/member'

/** 余料可再用的最小边宽（mm），小于此值视为碎料废弃 */
export const MIN_REMNANT_SIDE_MM = 50

export interface PackItem {
  memberId: string
  memberName: string
  jointTypeId: string
  grainDir: Member['grainDir']
  lengthMm: number
  widthMm: number
  thicknessMm: number
  qty: number
  cutRev: number
}

interface Rect {
  xMm: number
  yMm: number
  wMm: number
  hMm: number
}

interface WorkingBoard {
  board: Board
  freeRects: Rect[]
  placements: PackedPlacement[]
}

export interface PackRejection {
  /** GRAIN_MISMATCH：没有与构件纹向一致的板；CAPACITY：纹向对得上但容量/尺寸不足 */
  code: 'GRAIN_MISMATCH' | 'CAPACITY'
  memberId: string
  memberName: string
  grainDir: Member['grainDir']
  lengthMm: number
  widthMm: number
  thicknessMm: number
  message: string
}

export type PackResult =
  | { ok: true; packedBoards: PackedBoard[] }
  | { ok: false; rejections: PackRejection[] }

interface Unit {
  key: string
  memberId: string
  memberName: string
  jointTypeId: string
  grainDir: Member['grainDir']
  lengthMm: number
  widthMm: number
  thicknessMm: number
  rotated: boolean
}

/** 构件开料指纹：尺寸或纹向任一变化即改变，旧排样据此失效 */
export function memberCutFingerprint(member: Pick<Member, 'id' | 'grainDir' | 'lengthMm' | 'widthMm' | 'thicknessMm' | 'cutRev'>): string {
  return [
    member.id,
    member.grainDir,
    member.lengthMm,
    member.widthMm,
    member.thicknessMm,
    member.cutRev ?? 1,
  ].join('|')
}

/**
 * 排样规则：
 * - 顺纹件只能上顺纹板，且构件长边必须沿板长（禁止旋转）；
 * - 横纹件上横纹板，允许旋转 90° 落位；
 * - 板厚不得小于构件厚度；
 * - 构件必须落在板内且互不重叠（断头切分保证自由矩形互不重叠）；
 * - 任何一件放不下：整批拒绝，不产出部分排样。
 */
export function packBoards(items: PackItem[], boards: Board[]): PackResult {
  if (items.some((item) => item.qty > 0 && (
    item.lengthMm <= 0 || item.widthMm <= 0 || item.thicknessMm <= 0
  ))) {
    return {
      ok: false,
      rejections: [{
        code: 'CAPACITY',
        memberId: '',
        memberName: '',
        grainDir: '顺纹',
        lengthMm: 0,
        widthMm: 0,
        thicknessMm: 0,
        message: '存在尺寸为 0 或非法的构件，请先修正构件尺寸。',
      }],
    }
  }

  // 展开成单件；顺纹件先排（约束最强），同组按长边、宽度、厚度降序
  const units: Unit[] = items
    .filter((item) => item.qty > 0)
    .flatMap((item) => {
      // 顺纹件禁止旋转；横纹件先以原向登记，落位时再尝试旋转
      return Array.from({ length: item.qty }, () => ({
        key: item.memberId,
        memberId: item.memberId,
        memberName: item.memberName,
        jointTypeId: item.jointTypeId,
        grainDir: item.grainDir,
        lengthMm: item.lengthMm,
        widthMm: item.widthMm,
        thicknessMm: item.thicknessMm,
        rotated: false,
      }))
    })
    .sort((a, b) => {
      if (a.grainDir !== b.grainDir) return a.grainDir === '顺纹' ? -1 : 1
      if (b.lengthMm !== a.lengthMm) return b.lengthMm - a.lengthMm
      if (b.widthMm !== a.widthMm) return b.widthMm - a.widthMm
      return b.thicknessMm - a.thicknessMm
    })

  const working = new Map<string, WorkingBoard>()
  const rejections: PackRejection[] = []

  for (const unit of units) {
    const placement = placeUnit(unit, boards, working)
    if (!placement) {
      rejections.push(buildRejection(unit, boards))
    }
  }

  if (rejections.length > 0) {
    // 合并同一构件的多条原因
    const merged = new Map<string, PackRejection>()
    for (const rejection of rejections) {
      const key = rejection.memberId || rejection.message
      if (!merged.has(key)) merged.set(key, rejection)
    }
    return { ok: false, rejections: [...merged.values()] }
  }

  const packedBoards: PackedBoard[] = []
  for (const wb of working.values()) {
    const usable: PackedBoard['remnants'] = []
    let wasteAreaMm2 = 0
    for (const rect of wb.freeRects) {
      if (Math.min(rect.wMm, rect.hMm) >= MIN_REMNANT_SIDE_MM) {
        usable.push({
          xMm: rect.xMm,
          yMm: rect.yMm,
          wMm: rect.wMm,
          hMm: rect.hMm,
        })
      } else {
        wasteAreaMm2 += rect.wMm * rect.hMm
      }
    }
    packedBoards.push({
      boardId: wb.board.id,
      boardCode: wb.board.code,
      grainDir: wb.board.grainDir,
      lengthMm: wb.board.lengthMm,
      widthMm: wb.board.widthMm,
      thicknessMm: wb.board.thicknessMm,
      placements: wb.placements,
      remnants: usable,
      wasteAreaMm2,
    })
  }

  return { ok: true, packedBoards }
}

interface CandidatePlacement {
  working: WorkingBoard
  rect: Rect
  rotated: boolean
  itemW: number
  itemH: number
  tightness: number
  boardRank: number
  freeArea: number
  boardArea: number
  position: number
}

function placeUnit(
  unit: Unit,
  boards: Board[],
  working: Map<string, WorkingBoard>,
): PackedPlacement | null {
  const candidates: CandidatePlacement[] = []
  // 只有纹向一致、厚度足够的板可候选
  const eligibleBoards = boards.filter(
    (board) => board.grainDir === unit.grainDir && board.thicknessMm >= unit.thicknessMm,
  )

  for (const board of eligibleBoards) {
    let wb = working.get(board.id)
    if (!wb) {
      wb = {
        board,
        freeRects: [{ xMm: 0, yMm: 0, wMm: board.lengthMm, hMm: board.widthMm }],
        placements: [],
      }
      working.set(board.id, wb)
    }

    for (const rect of wb.freeRects) {
      // 顺纹件只能原向（长边沿板长）；横纹件优先原向，再试旋转
      const orientations = unit.grainDir === '顺纹'
        ? [{ rotated: false, w: unit.lengthMm, h: unit.widthMm }]
        : [
            { rotated: false, w: unit.lengthMm, h: unit.widthMm },
            { rotated: true, w: unit.widthMm, h: unit.lengthMm },
          ]
      for (const orientation of orientations) {
        if (rect.wMm >= orientation.w && rect.hMm >= orientation.h) {
          candidates.push({
            working: wb,
            rect,
            rotated: orientation.rotated,
            itemW: orientation.w,
            itemH: orientation.h,
            // 越紧越好：占用后这个自由矩形剩余面积最小
            tightness: rect.wMm * rect.hMm - orientation.w * orientation.h,
            // 0=已开余料；1=已开整板；2=未开余料；3=未开整板
            // 已开料的板永远优先，件尽量并到同一块少开新料
            boardRank: wb.placements.length > 0 ? (board.isRemnant ? 0 : 1) : (board.isRemnant ? 2 : 3),
            // 已开板按剩余总面积升序（填满）；未开板按板面升序（够用即可，不占大板）
            freeArea: wb.placements.length > 0
              ? wb.freeRects.reduce((sum, free) => sum + free.wMm * free.hMm, 0)
              : Number.POSITIVE_INFINITY,
            boardArea: board.lengthMm * board.widthMm,
            position: rect.xMm + rect.yMm,
          })
        }
      }
    }
  }

  if (candidates.length === 0) return null

  candidates.sort((a, b) => {
    if (a.boardRank !== b.boardRank) return a.boardRank - b.boardRank
    if (a.boardRank <= 1) {
      // 已开料的板：剩余空间越少越优先
      if (a.freeArea !== b.freeArea) return a.freeArea - b.freeArea
    } else if (a.boardArea !== b.boardArea) {
      // 未开料：板面越小越优先
      return a.boardArea - b.boardArea
    }
    if (a.tightness !== b.tightness) return a.tightness - b.tightness
    if (a.position !== b.position) return a.position - b.position
    return a.rotated === b.rotated ? 0 : a.rotated ? 1 : -1
  })
  const best = candidates[0]

  const { working: wb, rect, rotated, itemW, itemH } = best
  const occupied: Rect = { xMm: rect.xMm, yMm: rect.yMm, wMm: itemW, hMm: itemH }
  // 从全部自由矩形中减去本次落位矩形（落位可能在后续分片时覆盖其它旧矩形）
  wb.freeRects = wb.freeRects.flatMap((free) => subtractRect(free, occupied))
  wb.freeRects = pruneFreeRects(wb.freeRects)

  const placement: PackedPlacement = {
    memberId: unit.memberId,
    memberName: unit.memberName,
    jointTypeId: unit.jointTypeId,
    grainDir: unit.grainDir,
    xMm: rect.xMm,
    yMm: rect.yMm,
    wMm: itemW,
    hMm: itemH,
    rotated,
  }
  wb.placements.push(placement)
  return placement
}

/**
 * 自由空间集合减去落位矩形：按"左 / 右 / 上 / 下"四条带分片，
 * 条带互不重叠；与 cut 不相交或仅相切时原样返回。
 */
function subtractRect(free: Rect, cut: Rect): Rect[] {
  const intersects = free.xMm < cut.xMm + cut.wMm - 1e-9
    && free.xMm + free.wMm > cut.xMm + 1e-9
    && free.yMm < cut.yMm + cut.hMm - 1e-9
    && free.yMm + free.hMm > cut.yMm + 1e-9
  if (!intersects) return [free]

  const x0 = free.xMm
  const y0 = free.yMm
  const x1 = free.xMm + free.wMm
  const y1 = free.yMm + free.hMm
  const cx0 = Math.max(x0, cut.xMm)
  const cy0 = Math.max(y0, cut.yMm)
  const cx1 = Math.min(x1, cut.xMm + cut.wMm)
  const cy1 = Math.min(y1, cut.yMm + cut.hMm)

  const pieces: Rect[] = []
  // 左、右两条带占满全高
  if (cx0 - x0 > 1e-9) pieces.push({ xMm: x0, yMm: y0, wMm: cx0 - x0, hMm: y1 - y0 })
  if (x1 - cx1 > 1e-9) pieces.push({ xMm: cx1, yMm: y0, wMm: x1 - cx1, hMm: y1 - y0 })
  // 中列的上、下两段
  if (cy0 - y0 > 1e-9) pieces.push({ xMm: cx0, yMm: y0, wMm: cx1 - cx0, hMm: cy0 - y0 })
  if (y1 - cy1 > 1e-9) pieces.push({ xMm: cx0, yMm: cy1, wMm: cx1 - cx0, hMm: y1 - cy1 })
  return pieces
}

/**
 * 分片后可能产生被其它自由矩形完全包含的冗余块，剔除它们，
 * 使回库余料不重不漏。
 */
function pruneFreeRects(rects: Rect[]): Rect[] {
  return rects.filter((candidate) => {
    return !rects.some((other) => {
      if (other === candidate) return false
      const contained = other.xMm <= candidate.xMm + 1e-9
        && other.yMm <= candidate.yMm + 1e-9
        && other.xMm + other.wMm >= candidate.xMm + candidate.wMm - 1e-9
        && other.yMm + other.hMm >= candidate.yMm + candidate.hMm - 1e-9
      const strictlyLarger = other.wMm * other.hMm > candidate.wMm * candidate.hMm + 1e-9
      const sameSize = Math.abs(other.wMm * other.hMm - candidate.wMm * candidate.hMm) <= 1e-9
      // 被更大矩形包含则冗余；等大包含（重复矩形）只保留先出现的一个
      return (strictlyLarger && contained)
        || (sameSize && contained && rects.indexOf(other) < rects.indexOf(candidate))
    })
  })
}

function buildRejection(unit: Unit, boards: Board[]): PackRejection {  const sameGrain = boards.filter((board) => board.grainDir === unit.grainDir)
  const sizeText = `${unit.lengthMm}×${unit.widthMm}×${unit.thicknessMm}mm`
  if (sameGrain.length === 0) {
    return {
      code: 'GRAIN_MISMATCH',
      memberId: unit.memberId,
      memberName: unit.memberName,
      grainDir: unit.grainDir,
      lengthMm: unit.lengthMm,
      widthMm: unit.widthMm,
      thicknessMm: unit.thicknessMm,
      message: `「${unit.memberName}」${sizeText} 为${unit.grainDir}件，库存中没有${unit.grainDir}板，纹向不符，整批拒绝。`,
    }
  }
  const thickEnough = sameGrain.filter((board) => board.thicknessMm >= unit.thicknessMm)
  if (thickEnough.length === 0) {
    return {
      code: 'CAPACITY',
      memberId: unit.memberId,
      memberName: unit.memberName,
      grainDir: unit.grainDir,
      lengthMm: unit.lengthMm,
      widthMm: unit.widthMm,
      thicknessMm: unit.thicknessMm,
      message: `「${unit.memberName}」${sizeText} 需要厚度 ≥ ${unit.thicknessMm}mm 的${unit.grainDir}板，现有 ${sameGrain.length} 张${unit.grainDir}板均偏薄，容量不够，整批拒绝。`,
    }
  }
  return {
    code: 'CAPACITY',
    memberId: unit.memberId,
    memberName: unit.memberName,
    grainDir: unit.grainDir,
    lengthMm: unit.lengthMm,
    widthMm: unit.widthMm,
    thicknessMm: unit.thicknessMm,
    message: `「${unit.memberName}」${sizeText} 在现有 ${thickEnough.length} 张可用${unit.grainDir}板上排不下（板面或余料容量不够），整批拒绝。`,
  }
}

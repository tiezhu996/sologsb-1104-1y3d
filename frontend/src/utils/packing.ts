import type {
  BoardGrain,
  CutComponent,
  GrainRequirement,
  OffcutRect,
  Placement,
  UsedBoard,
} from '../types/cutting'

export type RejectKind = 'grain' | 'thickness' | 'capacity' | 'invalid'

export interface RejectReason {
  kind: RejectKind
  componentId: string
  name: string
  message: string
}

export interface PackInput {
  components: CutComponent[]
  boards: BoardLike[]
  sawKerfMm: number
  minOffcutMm: number
}

export interface BoardLike {
  id: string
  code: string
  species: string
  grain: BoardGrain
  lengthMm: number
  widthMm: number
  thicknessMm: number
}

export type PackResult =
  | { ok: true; boards: UsedBoard[]; usedAreaMm2: number; boardAreaMm2: number; utilizationPct: number }
  | { ok: false; reasons: RejectReason[] }

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Piece {
  componentId: string
  name: string
  seq: number
  area: number
}

interface FreeFit {
  free: Rect
  rotated: boolean
  occupiedW: number
  occupiedH: number
  /** 承载自由矩形面积，越小越贴合 */
  score: number
}

interface OpenBoard {
  board: BoardLike
  free: Rect[]
  used: Placement[]
  usedArea: number
}

/** 顺纹板（grain=along）上构件长边必须沿 x（板长边）；横纹板（grain=cross）上长边必须沿 y */
function orientationAllowed(mode: GrainRequirement, boardGrain: BoardGrain, rotated: boolean): boolean {
  if (mode === 'any') return true
  const longSideAlongX = !rotated
  return boardGrain === 'along' ? longSideAlongX : !longSideAlongX
}

function canCut(component: CutComponent, board: BoardLike): boolean {
  const grainOk = component.grainMode === 'any' || board.grain === (component.grainMode === 'along' ? 'along' : 'cross')
  return grainOk && board.thicknessMm + 1e-6 >= component.thicknessMm
}

/** 构件能否在指定板材上落下（按纹向限制判断转向） */
function componentFitsBoard(component: CutComponent, board: BoardLike): boolean {
  if (!canCut(component, board)) return false
  if (
    orientationAllowed(component.grainMode, board.grain, false)
    && component.lengthMm <= board.lengthMm
    && component.widthMm <= board.widthMm
  ) {
    return true
  }
  return (
    orientationAllowed(component.grainMode, board.grain, true)
    && component.widthMm <= board.lengthMm
    && component.lengthMm <= board.widthMm
  )
}

/**
 * Guillotine 两分区切分：落位恒在自由矩形左下角，沿余量较大的一侧开切，
 * 得到右侧、上方两个互不相交的条带（其一可为空），并集恰为剩余空间。
 */
function guillotineSplit(free: Rect, occupied: Rect): Rect[] {
  const x = free.x
  const y = free.y
  const w = free.w
  const h = free.h
  const usedW = occupied.w
  const usedH = occupied.h
  const remainW = w - usedW
  const remainH = h - usedH
  const result: Rect[] = []

  if (remainW >= remainH) {
    // 纵向开切：右侧整高条带 + 落位上方条带
    if (remainW > 1e-6) result.push({ x: x + usedW, y, w: remainW, h })
    if (remainH > 1e-6) result.push({ x, y: y + usedH, w: usedW, h: remainH })
  } else {
    // 横向开切：上方整宽条带 + 落位右侧条带
    if (remainH > 1e-6) result.push({ x, y: y + usedH, w, h: remainH })
    if (remainW > 1e-6) result.push({ x: x + usedW, y, w: remainW, h: usedH })
  }
  return result
}

/**
 * 从现有板材给待加工构件排样。
 *
 * 自由矩形 + guillotine 切分（MAXRECTS 思路）：每次切分得到互不相交的区域，
 * 天然保证构件不越界、不重叠；剩余自由矩形即整块余料，可直接登记回库。
 * 顺纹件锁死木纹方向、不可转向，任意纹允许 90° 转向；优先填已开的板，再开新板。
 * 容量、纹向或厚度无法满足时整批拒绝（ok: false），不动任何库存。
 */
export function packCutting(input: PackInput): PackResult {
  const { boards, sawKerfMm, minOffcutMm } = input
  const kerf = Math.max(0, sawKerfMm)
  const minOffcut = Math.max(0, minOffcutMm)

  if (!Number.isFinite(kerf) || !Number.isFinite(minOffcut) || kerf < 0 || minOffcut < 0) {
    return { ok: false, reasons: [{ kind: 'invalid', componentId: '', name: '', message: '锯路或最小余料尺寸不是有效数值' }] }
  }

  const components = input.components.filter((component) => component.qty > 0)
  for (const component of components) {
    if (
      !Number.isFinite(component.lengthMm)
      || !Number.isFinite(component.widthMm)
      || !Number.isFinite(component.thicknessMm)
      || component.lengthMm <= 0
      || component.widthMm <= 0
      || component.thicknessMm <= 0
    ) {
      return { ok: false, reasons: [{ kind: 'invalid', componentId: component.id, name: component.name, message: `「${component.name}」尺寸无效，整批不开料` }] }
    }
  }

  const pieces: Piece[] = []
  for (const component of components) {
    for (let seq = 1; seq <= component.qty; seq += 1) {
      pieces.push({ componentId: component.id, name: component.name, seq, area: component.lengthMm * component.widthMm })
    }
  }
  if (pieces.length === 0) {
    return { ok: false, reasons: [{ kind: 'invalid', componentId: '', name: '', message: '尚未添加待加工构件' }] }
  }

  const stockBoards = boards.filter((board) => board.lengthMm > 0 && board.widthMm > 0 && board.thicknessMm > 0)

  // 前置校验：任一构件无兼容板或任何板都放不下，整批拒绝
  const reasons: RejectReason[] = []
  const reported = new Set<string>()
  for (const component of components) {
    if (stockBoards.some((board) => componentFitsBoard(component, board))) continue
    const key = `${component.id}`
    if (reported.has(key)) continue
    reported.add(key)
    const thicknessOk = stockBoards.some((board) => board.thicknessMm + 1e-6 >= component.thicknessMm)
    const grainOk = stockBoards.some((board) => component.grainMode === 'any' || board.grain === component.grainMode)
    if (!thicknessOk) {
      reasons.push({ kind: 'thickness', componentId: component.id, name: component.name, message: `「${component.name}」厚 ${component.thicknessMm}mm，现有板材厚度均不足，整批拒绝` })
    } else if (!grainOk) {
      reasons.push({ kind: 'grain', componentId: component.id, name: component.name, message: `「${component.name}」为${component.grainMode === 'along' ? '顺纹件' : '横纹件'}，库存无匹配纹向的板材，整批拒绝` })
    } else {
      reasons.push({ kind: 'capacity', componentId: component.id, name: component.name, message: `「${component.name}」${component.lengthMm}×${component.widthMm}mm 超出所有兼容板材尺寸，整批拒绝` })
    }
  }
  if (reasons.length > 0) return { ok: false, reasons }

  const componentById = new Map(components.map((component) => [component.id, component]))

  // 大件优先：长边、短边、面积依次降序，难放的件先占位
  const sorted = [...pieces].sort((a, b) => {
    const ca = componentById.get(a.componentId)!
    const cb = componentById.get(b.componentId)!
    const aMax = Math.max(ca.lengthMm, ca.widthMm)
    const bMax = Math.max(cb.lengthMm, cb.widthMm)
    if (bMax !== aMax) return bMax - aMax
    const aMin = Math.min(ca.lengthMm, ca.widthMm)
    const bMin = Math.min(cb.lengthMm, cb.widthMm)
    if (bMin !== aMin) return bMin - aMin
    if (b.area !== a.area) return b.area - a.area
    return a.componentId.localeCompare(b.componentId) || a.seq - b.seq
  })

  const openBoards: OpenBoard[] = []
  const unusedBoards = [...stockBoards]

  const findFitInBoard = (component: CutComponent, openBoard: OpenBoard): FreeFit | null => {
    if (!canCut(component, openBoard.board)) return null
    let best: FreeFit | null = null
    for (const free of openBoard.free) {
      const straightW = component.lengthMm + kerf
      const straightH = component.widthMm + kerf
      const turnedW = component.widthMm + kerf
      const turnedH = component.lengthMm + kerf
      const options: Array<{ w: number; h: number; rotated: boolean }> = []
      if (orientationAllowed(component.grainMode, openBoard.board.grain, false)) {
        options.push({ w: straightW, h: straightH, rotated: false })
      }
      if (
        component.grainMode === 'any'
        && orientationAllowed(component.grainMode, openBoard.board.grain, true)
        && (turnedW !== straightW || turnedH !== straightH)
      ) {
        options.push({ w: turnedW, h: turnedH, rotated: true })
      }
      for (const option of options) {
        if (option.w > free.w + 1e-6 || option.h > free.h + 1e-6) continue
        // Best Area Fit：承载自由矩形面积越小越贴合；平局优先不转向，再取靠左靠下
        const score = free.w * free.h
        if (
          !best
          || score < best.score - 1e-6
          || (Math.abs(score - best.score) <= 1e-6 && (!option.rotated && best.rotated))
          || (Math.abs(score - best.score) <= 1e-6 && option.rotated === best.rotated
            && (free.y < best.free.y || (Math.abs(free.y - best.free.y) <= 1e-6 && free.x < best.free.x)))
        ) {
          best = { free, rotated: option.rotated, occupiedW: option.w, occupiedH: option.h, score }
        }
      }
    }
    return best
  }

  const commit = (piece: Piece, openBoard: OpenBoard, fit: FreeFit) => {
    const component = componentById.get(piece.componentId)!
    const occupied: Rect = { x: fit.free.x, y: fit.free.y, w: fit.occupiedW, h: fit.occupiedH }
    // 占位含锯路，构件本体取左下角、恢复真实尺寸
    openBoard.used.push({
      componentId: component.id,
      name: component.name,
      seq: piece.seq,
      x: occupied.x,
      y: occupied.y,
      lengthMm: fit.rotated ? component.widthMm : component.lengthMm,
      widthMm: fit.rotated ? component.lengthMm : component.widthMm,
      rotated: fit.rotated,
    })
    openBoard.usedArea += piece.area
    openBoard.free = openBoard.free.flatMap((free) => {
      // 只切分与落位相交的自由矩形；落位恒贴左下角，相交即包含落位左下角
      const touches = occupied.x >= free.x - 1e-6 && occupied.y >= free.y - 1e-6
        && occupied.x < free.x + free.w - 1e-6 && occupied.y < free.y + free.h - 1e-6
      return touches ? guillotineSplit(free, occupied) : [free]
    })
  }

  for (const piece of sorted) {
    const component = componentById.get(piece.componentId)!

    // 1) 先填已开板，选最贴合的一张
    let bestBoardFit: { openBoard: OpenBoard; fit: FreeFit } | null = null
    for (const openBoard of openBoards) {
      const fit = findFitInBoard(component, openBoard)
      if (fit && (!bestBoardFit || fit.score < bestBoardFit.fit.score)) {
        bestBoardFit = { openBoard, fit }
      }
    }
    if (bestBoardFit) {
      commit(piece, bestBoardFit.openBoard, bestBoardFit.fit)
      continue
    }

    // 2) 已开板放不下：开新板，优先用最小可容纳板，保留大板给后续构件
    let chosen: { board: BoardLike; rotated: boolean } | null = null
    for (const board of unusedBoards) {
      if (!canCut(component, board)) continue
      const straightFits = orientationAllowed(component.grainMode, board.grain, false)
        && component.lengthMm + kerf <= board.lengthMm
        && component.widthMm + kerf <= board.widthMm
      const turnedFits = component.grainMode === 'any'
        && orientationAllowed(component.grainMode, board.grain, true)
        && component.widthMm + kerf <= board.lengthMm
        && component.lengthMm + kerf <= board.widthMm
      if (!straightFits && !turnedFits) continue
      // 顺纹件永远不转向；任意纹优先不转向
      const rotated = !straightFits
      if (!chosen || board.lengthMm * board.widthMm < chosen.board.lengthMm * chosen.board.widthMm) {
        chosen = { board, rotated }
      }
    }
    if (!chosen) {
      // 前置校验已覆盖，兜底按容量不足整批拒绝
      return {
        ok: false,
        reasons: [{ kind: 'capacity', componentId: component.id, name: component.name, message: `「${component.name}」排样时剩余容量不足，整批拒绝` }],
      }
    }
    const boardIndex = unusedBoards.findIndex((board) => board.id === chosen!.board.id)
    unusedBoards.splice(boardIndex, 1)
    const openBoard: OpenBoard = {
      board: chosen.board,
      free: [{ x: 0, y: 0, w: chosen.board.lengthMm, h: chosen.board.widthMm }],
      used: [],
      usedArea: 0,
    }
    const occupiedW = (chosen.rotated ? component.widthMm : component.lengthMm) + kerf
    const occupiedH = (chosen.rotated ? component.lengthMm : component.widthMm) + kerf
    commit(piece, openBoard, { free: openBoard.free[0], rotated: chosen.rotated, occupiedW, occupiedH, score: openBoard.free[0].w * openBoard.free[0].h })
    openBoards.push(openBoard)
  }

  // 3) 汇总每块板的余料账：自由矩形双向都达到最小尺寸才整块回库，否则记碎料
  const usedBoards: UsedBoard[] = openBoards.map((openBoard) => {
    const offcuts: OffcutRect[] = []
    let wasteArea = 0
    for (const free of openBoard.free) {
      if (free.w >= minOffcut && free.h >= minOffcut) {
        offcuts.push({ x: free.x, y: free.y, lengthMm: free.w, widthMm: free.h })
      } else {
        wasteArea += free.w * free.h
      }
    }
    return {
      boardId: openBoard.board.id,
      code: openBoard.board.code,
      species: openBoard.board.species,
      grain: openBoard.board.grain,
      lengthMm: openBoard.board.lengthMm,
      widthMm: openBoard.board.widthMm,
      thicknessMm: openBoard.board.thicknessMm,
      rev: 0,
      placements: openBoard.used,
      offcuts,
      wasteAreaMm2: Math.round(wasteArea),
    }
  })

  const usedArea = usedBoards.reduce(
    (sum, board) => sum + board.placements.reduce((s, placement) => s + placement.lengthMm * placement.widthMm, 0),
    0,
  )
  const boardArea = usedBoards.reduce((sum, board) => sum + board.lengthMm * board.widthMm, 0)

  return {
    ok: true,
    boards: usedBoards,
    usedAreaMm2: Math.round(usedArea),
    boardAreaMm2: Math.round(boardArea),
    utilizationPct: boardArea > 0 ? Math.round((usedArea / boardArea) * 1000) / 10 : 0,
  }
}

export interface StaleInfo {
  stale: boolean
  reason?: string
}

interface PlanSnapshot {
  componentRefs: { componentId: string; rev: number; qty: number }[]
  boardRefs: { boardId: string; rev: number }[]
}

/** 按当前构件/板材快照复核旧排样：删除、rev 变化、数量不符、板被占用均判失效 */
export function checkPlanStaleness(
  plan: PlanSnapshot,
  components: CutComponent[],
  boards: { id: string; rev: number; status: string }[],
): StaleInfo {
  const componentMap = new Map(components.map((component) => [component.id, component]))
  for (const ref of plan.componentRefs) {
    const component = componentMap.get(ref.componentId)
    if (!component) return { stale: true, reason: '排样中的构件已被删除，旧排样失效，请重新排样。' }
    if (component.rev !== ref.rev) {
      return { stale: true, reason: `构件「${component.name}」的尺寸或纹向已修改，旧排样失效，请重新排样。` }
    }
    if (component.qty !== ref.qty) {
      return { stale: true, reason: `构件「${component.name}」的数量已修改，旧排样失效，请重新排样。` }
    }
  }
  const boardMap = new Map(boards.map((board) => [board.id, board]))
  for (const ref of plan.boardRefs) {
    const board = boardMap.get(ref.boardId)
    if (!board) return { stale: true, reason: '排样占用的板材已被删除，旧排样失效，请重新排样。' }
    if (board.status !== 'in_stock') {
      return { stale: true, reason: '排样占用的板材已被另一开料批次扣减，本批未提交，请重新排样。' }
    }
    if (board.rev !== ref.rev) return { stale: true, reason: '排样占用的板材尺寸已修改，旧排样失效，请重新排样。' }
  }
  return { stale: false }
}

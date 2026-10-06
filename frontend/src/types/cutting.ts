/** 板材纹理方向：along 纹理沿长边（顺纹板），cross 纹理沿短边（横纹板） */
export type BoardGrain = 'along' | 'cross'
/** 构件下刀纹向：along 顺纹件（必须顺纹、不可转向），any 任意纹（可 90° 转向） */
export type GrainRequirement = 'along' | 'any'
export type BoardStatus = 'in_stock' | 'consumed'
export type BoardSource = 'purchase' | 'offcut'
export type BatchStatus = 'draft' | 'confirmed'

export interface BoardStock {
  id: string
  /** 料号，如 YL-001；余料回库时自动派生 */
  code: string
  species: string
  grain: BoardGrain
  lengthMm: number
  widthMm: number
  thicknessMm: number
  status: BoardStatus
  source: BoardSource
  /** 余料来源母板 */
  parentBoardId?: string
  /** 余料由哪一开料批次产生 */
  batchId?: string
  rev: number
  createdAt: number
}

export interface CutComponent {
  id: string
  name: string
  grainMode: GrainRequirement
  lengthMm: number
  widthMm: number
  thicknessMm: number
  qty: number
  rev: number
  createdAt: number
}

/** 单件构件在板材上的落位，坐标原点为板材左下角，x 沿长边、y 沿短边 */
export interface Placement {
  componentId: string
  name: string
  seq: number
  x: number
  y: number
  /** 排样后的实际占位尺寸（含木纹方向语义，不含锯路） */
  lengthMm: number
  widthMm: number
  /** 是否相对构件原尺寸旋转了 90° */
  rotated: boolean
}

export interface OffcutRect {
  x: number
  y: number
  lengthMm: number
  widthMm: number
}

export interface UsedBoard {
  boardId: string
  code: string
  species: string
  grain: BoardGrain
  lengthMm: number
  widthMm: number
  thicknessMm: number
  rev: number
  placements: Placement[]
  /** 达到最小回库尺寸、可成板回库的余料区域 */
  offcuts: OffcutRect[]
  /** 未回库的碎料面积（含锯路以外的零头） */
  wasteAreaMm2: number
}

export interface PlanComponentRef {
  componentId: string
  rev: number
  qty: number
}

export interface PlanBoardRef {
  boardId: string
  rev: number
}

export interface CutPlan {
  plannedAt: number
  sawKerfMm: number
  minOffcutMm: number
  boards: UsedBoard[]
  componentRefs: PlanComponentRef[]
  boardRefs: PlanBoardRef[]
  usedAreaMm2: number
  boardAreaMm2: number
  /** 构件净面积 / 占用板材总面积 */
  utilizationPct: number
}

export interface CutBatch {
  id: string
  name: string
  note: string
  status: BatchStatus
  sawKerfMm: number
  minOffcutMm: number
  /** 当前排样；为 null 表示尚未排样 */
  plan: CutPlan | null
  /** 旧排样是否已失效（构件/板材改动或被其他页签抢先占用） */
  invalidated: boolean
  staleReason?: string
  rev: number
  createdAt: number
  updatedAt: number
  confirmedAt?: number
  recordId?: string
}

export interface CutRecordComponent {
  componentId: string
  name: string
  grainMode: GrainRequirement
  lengthMm: number
  widthMm: number
  thicknessMm: number
  qty: number
}

export interface CutRecordBoard {
  boardId: string
  code: string
  species: string
  grain: BoardGrain
  lengthMm: number
  widthMm: number
  thicknessMm: number
}

export interface CutRecordOffcut {
  boardId: string
  code: string
  species: string
  grain: BoardGrain
  lengthMm: number
  widthMm: number
  thicknessMm: number
  parentBoardId: string
}

/** 开料流水：确认时整体写入，不可变 */
export interface CutRecord {
  id: string
  batchId: string
  batchName: string
  note: string
  confirmedAt: number
  consumedBoards: CutRecordBoard[]
  offcuts: CutRecordOffcut[]
  components: CutRecordComponent[]
  totalPieces: number
  sawKerfMm: number
  utilizationPct: number
}

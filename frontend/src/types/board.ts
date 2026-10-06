import type { GrainDirection } from './member'

/**
 * 库存板材 / 回库余料。
 * 木料纹理方向沿长边；余料由整板或更早的余料切出，provenance 记录来源链。
 */
export interface Board {
  id: string
  /** 料牌编码，整板入库时给出，余料自动派生 */
  code: string
  grainDir: GrainDirection
  lengthMm: number
  widthMm: number
  thicknessMm: number
  /** 余料 = true；整板 = false */
  isRemnant: boolean
  /** 切出本余料的板材 id；整板为空 */
  sourceBoardId?: string
  /** 首次入库时间戳 */
  createdAt: number
  note?: string
}

/** 排样中单个构件在某张板材上的落位 */
export interface PackedPlacement {
  memberId: string
  memberName: string
  jointTypeId: string
  grainDir: GrainDirection
  /** 相对板材左下角的坐标与尺寸（毫米） */
  xMm: number
  yMm: number
  wMm: number
  hMm: number
  /** 是否相对构件原始长宽旋转 90°（顺纹件禁止旋转） */
  rotated: boolean
}

/** 一张板材上的排样结果 */
export interface PackedBoard {
  boardId: string
  boardCode: string
  grainDir: GrainDirection
  lengthMm: number
  widthMm: number
  thicknessMm: number
  placements: PackedPlacement[]
  /** 本板切割后准备回库的余料（自由矩形坐标，x 沿板长/纹向） */
  remnants: Array<{
    xMm: number
    yMm: number
    /** 沿板长方向的尺寸 */
    wMm: number
    /** 沿板宽方向的尺寸 */
    hMm: number
  }>
  /** 废弃碎料面积 mm² */
  wasteAreaMm2: number
}

/** 确认开料后留下的开料记录 */
export interface CutRecord {
  id: string
  batchNo: string
  cutAt: number
  memberCount: number
  placements: Array<{
    memberId: string
    memberName: string
    grainDir: GrainDirection
    boardCode: string
    lengthMm: number
    widthMm: number
    rotated: boolean
  }>
  /** 扣减（整料消耗）的板材 */
  consumedBoards: Array<{
    boardId: string
    boardCode: string
    lengthMm: number
    widthMm: number
    thicknessMm: number
    grainDir: GrainDirection
  }>
  /** 回库的余料 */
  returnedRemnants: Array<{
    boardId: string
    boardCode: string
    lengthMm: number
    widthMm: number
    thicknessMm: number
    grainDir: GrainDirection
    sourceBoardId: string
  }>
  wasteAreaMm2: number
  note?: string
}

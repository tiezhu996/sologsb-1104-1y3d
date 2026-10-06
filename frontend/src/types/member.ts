export type MemberName = '榫头' | '榫眼' | '大边' | '抹头'
export type MemberPart = '出榫件' | '受榫件'
export type GrainDirection = '顺纹' | '横纹'

export interface Member {
  id: string
  jointTypeId: string
  name: MemberName
  part: MemberPart
  grainDir: GrainDirection
  lengthMm: number
  widthMm: number
  thicknessMm: number
  toleranceMm: number
  note: string
  schemaRev?: number
  /**
   * 开料版本：尺寸或纹向每变更一次加一。
   * 排样会快照当时的 cutRev，与当前值不符则旧排样失效，必须重排。
   */
  cutRev?: number
}

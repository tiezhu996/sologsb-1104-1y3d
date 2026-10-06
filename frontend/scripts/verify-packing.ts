import assert from 'node:assert'
import { packBoards, MIN_REMNANT_SIDE_MM } from '../src/utils/packing'
import type { Board } from '../src/types/board'
import type { PackItem } from '../src/utils/packing'

let failures = 0
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`) }
  catch (error) { failures++; console.error(`  ✕ ${name}\n    ${error.message}`) }
}

const boards: Board[] = [
  { id: 's1', code: 'S1', grainDir: '顺纹', lengthMm: 1000, widthMm: 100, thicknessMm: 30, isRemnant: false, createdAt: 1 },
  { id: 's2', code: 'S2', grainDir: '顺纹', lengthMm: 500, widthMm: 80, thicknessMm: 20, isRemnant: false, createdAt: 2 },
  { id: 'h1', code: 'H1', grainDir: '横纹', lengthMm: 600, widthMm: 120, thicknessMm: 30, isRemnant: false, createdAt: 3 },
  { id: 'r1', code: 'S1-Y01', grainDir: '顺纹', lengthMm: 300, widthMm: 60, thicknessMm: 30, isRemnant: true, sourceBoardId: 's1', createdAt: 4 },
]

function item(partial: Partial<PackItem> & Pick<PackItem, 'memberId' | 'memberName' | 'grainDir'>): PackItem {
  return {
    jointTypeId: 'j1', lengthMm: 100, widthMm: 50, thicknessMm: 20, qty: 1, cutRev: 1,
    ...partial,
  }
}

function validateGeometry(result) {
  for (const packed of result.packedBoards) {
    const board = boards.find((b) => b.id === packed.boardId)!
    for (const p of packed.placements) {
      assert(p.xMm >= 0 && p.yMm >= 0, '越界：负坐标')
      assert(p.xMm + p.wMm <= board.lengthMm + 1e-9, `越界：x ${p.xMm}+${p.wMm} > ${board.lengthMm}`)
      assert(p.yMm + p.hMm <= board.widthMm + 1e-9, `越界：y ${p.yMm}+${p.hMm} > ${board.widthMm}`)
      assert(p.grainDir === board.grainDir, '纹向不一致')
      if (p.grainDir === '顺纹') assert(!p.rotated, '顺纹件被旋转')
    }
    for (let i = 0; i < packed.placements.length; i++) {
      for (let j = i + 1; j < packed.placements.length; j++) {
        const a = packed.placements[i]
        const b = packed.placements[j]
        const overlap = a.xMm < b.xMm + b.wMm - 1e-9 && a.xMm + a.wMm > b.xMm + 1e-9
          && a.yMm < b.yMm + b.hMm - 1e-9 && a.yMm + a.hMm > b.yMm + 1e-9
        assert(!overlap, `重叠：${a.memberName} 与 ${b.memberName} 在 ${packed.boardCode}`)
      }
    }
    for (const r of packed.remnants) {
      assert(Math.min(r.wMm, r.hMm) >= MIN_REMNANT_SIDE_MM, '余料边宽低于阈值')
      assert(r.xMm + r.wMm <= board.lengthMm + 1e-9 && r.yMm + r.hMm <= board.widthMm + 1e-9, '余料越界')
    }
    // 回库余料两两不重叠
    for (let i = 0; i < packed.remnants.length; i++) {
      for (let j = i + 1; j < packed.remnants.length; j++) {
        const a = packed.remnants[i]
        const b = packed.remnants[j]
        const overlap = a.xMm < b.xMm + b.wMm - 1e-9 && a.xMm + a.wMm > b.xMm + 1e-9
          && a.yMm < b.yMm + b.hMm - 1e-9 && a.yMm + a.hMm > b.yMm + 1e-9
        assert(!overlap, `余料重叠（${packed.boardCode}）`)
      }
    }
    // 余料不与任何构件重叠
    for (const r of packed.remnants) {
      for (const p of packed.placements) {
        const overlap = r.xMm < p.xMm + p.wMm - 1e-9 && r.xMm + r.wMm > p.xMm + 1e-9
          && r.yMm < p.yMm + p.hMm - 1e-9 && r.yMm + r.hMm > p.yMm + 1e-9
        assert(!overlap, `余料与构件 ${p.memberName} 重叠（${packed.boardCode}）`)
      }
    }
  }
}

console.log('排样算法验证')

check('顺纹件只上顺纹板且不旋转，全部能放下', () => {
  const result = packBoards([
    item({ memberId: 'm1', memberName: '顺纹长料', grainDir: '顺纹', lengthMm: 900, widthMm: 40, thicknessMm: 25 }),
  ], boards)
  assert(result.ok, '应成功')
  validateGeometry(result)
  assert(result.packedBoards[0].grainDir === '顺纹')
})

check('没有横纹板以外的混放：顺纹 + 横纹各归各板', () => {
  const result = packBoards([
    item({ memberId: 'm1', memberName: '顺纹件', grainDir: '顺纹', lengthMm: 200, widthMm: 50 }),
    item({ memberId: 'm2', memberName: '横纹件', grainDir: '横纹', lengthMm: 200, widthMm: 50 }),
  ], boards)
  assert(result.ok, '应成功')
  validateGeometry(result)
  const codes = result.packedBoards.map((p) => p.boardCode)
  assert(codes.includes('H1') && codes.some((c) => c !== 'H1'), '应分别落在顺纹板与横纹板')
})

check('纹向不符时整批拒绝 GRAIN_MISMATCH', () => {
  const onlyShun = boards.filter((b) => b.grainDir === '顺纹')
  const result = packBoards([
    item({ memberId: 'm2', memberName: '横纹件', grainDir: '横纹' }),
  ], onlyShun)
  assert(!result.ok && result.rejections[0].code === 'GRAIN_MISMATCH', '应判纹向不符')
})

check('容量不够时整批拒绝 CAPACITY（不产出部分排样）', () => {
  const result = packBoards([
    item({ memberId: 'm1', memberName: '超大顺纹件', grainDir: '顺纹', lengthMm: 1200, widthMm: 90, thicknessMm: 30, qty: 2 }),
  ], boards)
  assert(!result.ok, '应失败')
  assert(result.rejections.every((r) => r.code === 'CAPACITY'), '应判容量不足')
})

check('多件并排不重叠（顺纹板放 5 件 180×40）', () => {
  const result = packBoards([
    item({ memberId: 'm1', memberName: '顺纹件', grainDir: '顺纹', lengthMm: 180, widthMm: 40, qty: 5 }),
  ], boards)
  assert(result.ok, '应成功（1000 长可放 5 件）')
  validateGeometry(result)
  assert(result.packedBoards.every((p) => p.placements.length <= 5))
  const total = result.packedBoards.reduce((s, p) => s + p.placements.length, 0)
  assert.strictEqual(total, 5)
})

check('顺纹板容量边界：板宽仅容单行，6×180=1080>1000 时整批拒绝', () => {
  const single = [boards[0]]
  const result = packBoards([
    item({ memberId: 'm1', memberName: '顺纹件', grainDir: '顺纹', lengthMm: 180, widthMm: 60, qty: 6 }),
  ], single)
  assert(!result.ok && result.rejections[0].code === 'CAPACITY')
})

check('厚度超板厚判容量不足', () => {
  const result = packBoards([
    item({ memberId: 'm1', memberName: '厚顺纹件', grainDir: '顺纹', lengthMm: 50, widthMm: 40, thicknessMm: 40 }),
  ], boards)
  assert(!result.ok && result.rejections[0].code === 'CAPACITY')
})

check('横纹件允许旋转落位（宽大于长时旋转成功）', () => {
  const result = packBoards([
    item({ memberId: 'm2', memberName: '横纹件', grainDir: '横纹', lengthMm: 110, widthMm: 200, thicknessMm: 20, qty: 3 }),
  ], boards)
  assert(result.ok, '旋转后 200 沿板长、110 沿板宽，600 可放 3 件')
  validateGeometry(result)
  assert(result.packedBoards.some((p) => p.placements.some((pl) => pl.rotated)), '应有旋转落位')
})

check('优先消耗余料：顺纹小件先上 r1(300×60)', () => {
  const result = packBoards([
    item({ memberId: 'm1', memberName: '顺纹小件', grainDir: '顺纹', lengthMm: 120, widthMm: 40, qty: 2 }),
  ], boards)
  assert(result.ok)
  validateGeometry(result)
  const onRemnant = result.packedBoards.find((p) => p.boardId === 'r1')
  assert(onRemnant && onRemnant.placements.length === 2, '两件应都进余料 300×60')
})

check('余料回存：单板全切后产出合法余料并正确计废弃面积', () => {
  const single = [{ ...boards[0] }]
  const result = packBoards([
    item({ memberId: 'm1', memberName: '顺纹件', grainDir: '顺纹', lengthMm: 1000, widthMm: 60, thicknessMm: 20 }),
  ], single)
  assert(result.ok)
  const packed = result.packedBoards[0]
  // 剩余 1000×40 条带：min side=40 < 50 → 废弃，无余料
  assert.strictEqual(packed.remnants.length, 0)
  assert(Math.abs(packed.wasteAreaMm2 - 1000 * 40) < 1e-6)
})

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')

import 'fake-indexeddb/auto'
import assert from 'node:assert'
import { db } from '../src/utils/db'
import { commitCut, type LayoutSnapshot } from '../src/stores/cuttingStore'
import { packBoards, memberCutFingerprint, type PackItem } from '../src/utils/packing'
import type { Board } from '../src/types/board'
import type { Member } from '../src/types/member'

let failures = 0
function check(name: string, fn: () => Promise<void>) {
  return fn().then(
    () => console.log(`  ✓ ${name}`),
    (error: unknown) => { failures++; console.error(`  ✕ ${name}\n    ${(error as Error).message}`) },
  )
}

async function resetDb() {
  await db.open()
  await Promise.all([
    db.boards.clear(),
    db.members.clear(),
    db.joints.clear(),
    db.steps.clear(),
    db.diagrams.clear(),
    db.furniture.clear(),
    db.cutRecords.clear(),
  ])
}

const shunBoard: Board = {
  id: 'board-a', code: 'SB-A', grainDir: '顺纹', lengthMm: 1000, widthMm: 100, thicknessMm: 30,
  isRemnant: false, createdAt: 1,
}
const otherBoard: Board = {
  id: 'board-b', code: 'SB-B', grainDir: '顺纹', lengthMm: 400, widthMm: 100, thicknessMm: 10,
  isRemnant: false, createdAt: 2,
}
const member: Member = {
  id: 'member-a', jointTypeId: 'joint-x', name: '大边', part: '出榫件',
  grainDir: '顺纹', lengthMm: 180, widthMm: 60, thicknessMm: 20, toleranceMm: 0.2, note: '', cutRev: 1,
}

function snapshotFor(items: PackItem[], boards: Board[]): LayoutSnapshot {
  const result = packBoards(items, boards)
  if (!result.ok) throw new Error('排样本应成功: ' + result.rejections.map((r) => r.message).join(';'))
  const fingerprints: Record<string, string> = {}
  for (const item of items) fingerprints[item.memberId] = [
    item.memberId, item.grainDir, item.lengthMm, item.widthMm, item.thicknessMm, item.cutRev,
  ].join('|')
  return { packedBoards: result.packedBoards, fingerprints, packedAt: Date.now() }
}

const itemA: PackItem = {
  memberId: 'member-a', memberName: '大边', jointTypeId: 'joint-x',
  // 宽 60：板宽 100 仅容单行，4 件排成一长条，余料形态可预期
  grainDir: '顺纹', lengthMm: 180, widthMm: 60, thicknessMm: 20, qty: 4, cutRev: 1,
}

async function run() {
  console.log('开料事务验证（fake-indexeddb）')

  await check('两个页签并发提交同一批木料：只成功一次', async () => {
    await resetDb()
    await db.boards.bulkAdd([shunBoard, otherBoard])
    await db.members.add(member)
    const boards = await db.boards.toArray()
    const snapshot = snapshotFor([itemA], boards)

    const [first, second] = await Promise.all([
      commitCut(snapshot),
      commitCut(snapshot),
    ])
    assert(first.ok, `先到者应成功: ${JSON.stringify(first)}`)
    assert(!second.ok && second.reason === 'board-changed',
      `后到者应因板材已扣减而失败: ${JSON.stringify(second)}`)

    const remaining = await db.boards.toArray()
    // 成功的一笔：扣 1 张源板；单行 4×180 后，右侧 280×100 为整块回库余料
    assert(!remaining.some((b) => b.id === 'board-a'), '源板应已扣减')
    const remnants = remaining.filter((b) => b.isRemnant)
    assert.strictEqual(remnants.length, 1, `应恰好回存 1 块余料，实际 ${remnants.length}: ${JSON.stringify(remnants.map((r) => [r.lengthMm, r.widthMm]))}`)
    assert.strictEqual(remnants[0].lengthMm, 280)
    assert.strictEqual(remnants[0].widthMm, 100)
    assert(remnants[0].code.startsWith('SB-A-Y'), '余料料牌应派生自源板')
    // 未被排样引用的 board-b 必须原样保留（全有或全无）
    assert(remaining.some((b) => b.id === 'board-b'), '未引用的板不得被动')

    const records = await db.cutRecords.toArray()
    assert.strictEqual(records.length, 1, '应只留 1 条开料记录')
    assert.strictEqual(records[0].memberCount, 4)
    assert.strictEqual(records[0].consumedBoards.length, 1)
    assert.strictEqual(records[0].returnedRemnants.length, 1)
  })

  await check('后到者失败后不影响库存，草稿可基于新库存重排并成功', async () => {
    // 接上一场景的库：用回库余料 280×100 开 1 件 200×60 顺纹件（应优先吃余料）
    const memberB: Member = { ...member, id: 'member-b', name: '抹头', lengthMm: 200, widthMm: 60, thicknessMm: 20, cutRev: 1 }
    await db.members.add(memberB)
    const boards = await db.boards.toArray()
    const items: PackItem[] = [{
      memberId: 'member-b', memberName: '抹头', jointTypeId: 'joint-x',
      grainDir: '顺纹', lengthMm: 200, widthMm: 60, thicknessMm: 20, qty: 1, cutRev: 1,
    }]
    const snapshot = snapshotFor(items, boards)
    const outcome = await commitCut(snapshot)
    assert(outcome.ok, `重排后应成功: ${JSON.stringify(outcome)}`)
    const remaining = await db.boards.toArray()
    // 280×100 余料可容下 200×60，优先消耗；未引用的整板 SB-B 不得被动
    assert(!remaining.some((b) => b.code === 'SB-A-Y01'), '余料应被优先消耗')
    assert(remaining.some((b) => b.id === 'board-b'), '整板 SB-B 仍应保留')
    // 余料切后回存：右条带 80×100（min 边 80≥50）
    const newRemnants = remaining.filter((b) => b.isRemnant)
    assert(newRemnants.some((b) => b.lengthMm === 100 && b.widthMm === 80),
      `应回存 100×80 余料，实际 ${JSON.stringify(newRemnants.map((r) => [r.lengthMm, r.widthMm]))}`)
    const count = await db.cutRecords.count()
    assert.strictEqual(count, 2)
  })

  await check('两批互不重叠的板材并发提交：各自成功', async () => {
    await resetDb()
    const boardC: Board = { ...otherBoard, id: 'board-c', code: 'SB-C', lengthMm: 1000, thicknessMm: 30 }
    await db.boards.bulkAdd([shunBoard, boardC])
    await db.members.add(member)
    const snapshotA = snapshotFor([itemA], [shunBoard])
    const snapshotB = snapshotFor([{ ...itemA, memberId: 'member-a', qty: 2 }], [boardC])
    const [a, b] = await Promise.all([commitCut(snapshotA), commitCut(snapshotB)])
    assert(a.ok && b.ok, `两批都应成功: ${JSON.stringify([a, b])}`)
    const records = await db.cutRecords.toArray()
    assert.strictEqual(records.length, 2)
  })

  await check('构件尺寸被修改后，旧排样提交被拒且不扣料', async () => {
    await resetDb()
    await db.boards.bulkAdd([shunBoard])
    await db.members.add(member)
    const snapshot = snapshotFor([itemA], [shunBoard])
    // 另一处把构件加长（cutRev 递增），模拟"尺寸修改后旧排样失效"
    await db.members.update('member-a', { lengthMm: 260, cutRev: 2 })
    const outcome = await commitCut(snapshot)
    assert(!outcome.ok && outcome.reason === 'member-changed', `应判构件已变: ${JSON.stringify(outcome)}`)
    const boards = await db.boards.toArray()
    assert(boards.some((b) => b.id === 'board-a'), '板材必须原样保留')
    assert.strictEqual(await db.cutRecords.count(), 0, '不得写记录')
  })

  await check('指纹函数对纹向变化敏感', async () => {
    const a = memberCutFingerprint(member)
    const b = memberCutFingerprint({ ...member, grainDir: '横纹' })
    const c = memberCutFingerprint({ ...member, cutRev: 2 })
    assert(a !== b && a !== c)
  })

  if (failures > 0) {
    console.error(`\n${failures} 项失败`)
    process.exit(1)
  }
  console.log('\n全部通过')
  await db.close()
}

void run()

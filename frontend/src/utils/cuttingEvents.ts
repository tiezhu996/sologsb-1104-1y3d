/**
 * 跨页签同步：
 * - 库存（板材）或开料记录变化时，通知其它已打开的开料台刷新数据；
 * - 开料确认成功后，通知其它页签——它们持有的同一批排样已失效，保留草稿并提示重排。
 * 优先使用 BroadcastChannel；不支持时退化到 localStorage storage 事件。
 */

export interface StockMutatedMessage {
  type: 'stock-mutated'
  at: number
}

export interface CutCommittedMessage {
  type: 'cut-committed'
  /** 本次开料消耗的板材 id（含由它切出余料的源板） */
  consumedBoardIds: string[]
  batchNo: string
  at: number
}

export type CuttingMessage = StockMutatedMessage | CutCommittedMessage

const CHANNEL_NAME = 'gbmortise-cutting'
const FALLBACK_KEY = 'gbmortise-cutting-event'

let channel: BroadcastChannel | null = null
const listeners = new Set<(message: CuttingMessage) => void>()

function getChannel(): BroadcastChannel | null {
  if (channel !== null) return channel
  // 非浏览器环境（如 Node 验证脚本）不建立通道，避免挂住事件循环
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    channel = null
  } else {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = (event: MessageEvent<CuttingMessage>) => {
      listeners.forEach((listener) => listener(event.data))
    }
  }
  return channel
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== FALLBACK_KEY || !event.newValue) return
    try {
      const message = JSON.parse(event.newValue) as CuttingMessage
      listeners.forEach((listener) => listener(message))
    } catch {
      // 忽略无法解析的兜底事件
    }
  })
}

export function postCuttingMessage(message: CuttingMessage): void {
  const bc = getChannel()
  if (bc) {
    bc.postMessage(message)
  } else if (typeof localStorage !== 'undefined') {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(message))
  }
}

export function subscribeCuttingMessages(listener: (message: CuttingMessage) => void): () => void {
  getChannel()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

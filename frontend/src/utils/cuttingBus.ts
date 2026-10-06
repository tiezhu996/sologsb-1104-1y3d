/**
 * 开料台跨页签广播：一个页签改动板材/构件或确认开料后，
 * 其他页签据此即时重算排样有效性，避免两页签同时提交同一批木料。
 */
export type CuttingBusMessage =
  | { type: 'boards-changed' }
  | { type: 'components-changed' }
  | { type: 'batch-confirmed'; batchId: string; recordId: string; at: number }

const CHANNEL_NAME = 'gbmortise-cutting'

let channel: BroadcastChannel | null = null
if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel(CHANNEL_NAME)
}

export function postCuttingMessage(message: CuttingBusMessage): void {
  channel?.postMessage(message)
}

export function onCuttingMessage(handler: (message: CuttingBusMessage) => void): () => void {
  if (!channel) return () => undefined
  const listener = (event: MessageEvent<CuttingBusMessage>) => handler(event.data)
  channel.addEventListener('message', listener)
  return () => channel?.removeEventListener('message', listener)
}

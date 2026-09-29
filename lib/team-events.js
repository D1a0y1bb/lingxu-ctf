/** Parse a delivered DSH team message without taking part in delivery. */
export function teamDeliveryOf(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'user/message') return null
  const source = event.data?.source
  if (source === null || typeof source !== 'object' || source.kind !== 'team-message') return null

  const blocks = Array.isArray(event.data?.content)
    ? event.data.content
    : event.data?.message?.content
  const parts = []
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }

  const text = parts.join('\n').replace(/^Team message \S+ from [^:]*:\s*\n?/, '').trim()
  const time = Number(event.time)
  return {
    messageId: String(source.messageId ?? ''),
    from: String(source.senderName ?? source.senderId ?? 'unknown'),
    kind: 'interactive',
    text,
    at: Number.isFinite(time) ? time : null,
  }
}

export default { teamDeliveryOf }

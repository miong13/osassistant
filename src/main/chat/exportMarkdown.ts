import type { ChatMessage, Conversation } from '../../shared/types'

export function toMarkdown(c: Conversation, messages: ChatMessage[]): string {
  const lines = [`# ${c.title}`, '', `_${new Date(c.createdAt).toLocaleString()} · ${c.model}_`, '']
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text' && p.text.trim()) {
        lines.push(m.role === 'user' ? '## You' : '## Assistant', '', p.text, '')
      } else if (p.type === 'tool_call') {
        lines.push(`> 🔧 Used tool \`${p.name}\``, '', '```json', JSON.stringify(p.input, null, 2), '```', '')
      } else if (p.type === 'tool_result') {
        const body = p.content.length > 2000 ? p.content.slice(0, 2000) + '\n…' : p.content
        lines.push(`> Result${p.isError ? ' (error)' : ''}:`, '', '```', body, '```', '')
      }
    }
  }
  return lines.join('\n')
}

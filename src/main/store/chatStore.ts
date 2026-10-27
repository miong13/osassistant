import type { ChatMessage, Conversation } from '../../shared/types'

/** Storage used by the chat orchestrator. SQLite in the app, in-memory in tests. */
export interface ChatStore {
  createConversation(c: Conversation): void
  getConversation(id: string): Conversation | undefined
  updateConversation(id: string, patch: Partial<Omit<Conversation, 'id'>>): void
  listConversations(query?: string): Conversation[]
  deleteConversation(id: string): void
  addMessage(m: ChatMessage): void
  getMessages(conversationId: string): ChatMessage[]
}

export class MemoryChatStore implements ChatStore {
  conversations = new Map<string, Conversation>()
  messages: ChatMessage[] = []

  createConversation(c: Conversation): void {
    this.conversations.set(c.id, { ...c })
  }
  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id)
  }
  updateConversation(id: string, patch: Partial<Omit<Conversation, 'id'>>): void {
    const c = this.conversations.get(id)
    if (c) this.conversations.set(id, { ...c, ...patch })
  }
  listConversations(query?: string): Conversation[] {
    const q = query?.toLowerCase()
    return [...this.conversations.values()]
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }
  deleteConversation(id: string): void {
    this.conversations.delete(id)
    this.messages = this.messages.filter((m) => m.conversationId !== id)
  }
  addMessage(m: ChatMessage): void {
    this.messages.push(m)
  }
  getMessages(conversationId: string): ChatMessage[] {
    return this.messages.filter((m) => m.conversationId === conversationId)
  }
}

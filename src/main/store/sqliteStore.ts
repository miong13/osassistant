import type { ChatMessage, Conversation } from '../../shared/types'
import type { ChatStore } from './chatStore'

// Electron ships Node's built-in SQLite (node:sqlite), so no native module is needed.
interface Statement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Record<string, unknown>[]
}
interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}
interface SqliteModule {
  DatabaseSync: new (path: string) => Database
}

function loadSqlite(): SqliteModule {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown })
    .getBuiltinModule
  if (!getBuiltin) throw new Error('This Electron version does not include node:sqlite')
  return getBuiltin('node:sqlite') as SqliteModule
}

function rowToConversation(r: Record<string, unknown>): Conversation {
  return {
    id: String(r.id),
    title: String(r.title),
    characterId: String(r.character_id),
    providerId: String(r.provider_id),
    model: String(r.model),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  }
}

export class SqliteChatStore implements ChatStore {
  private db: Database

  constructor(file: string) {
    const { DatabaseSync } = loadSqlite()
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        character_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        parts_json TEXT NOT NULL,
        raw_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);
    `)
  }

  createConversation(c: Conversation): void {
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, character_id, provider_id, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(c.id, c.title, c.characterId, c.providerId, c.model, c.createdAt, c.updatedAt)
  }

  getConversation(id: string): Conversation | undefined {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id)
    return r ? rowToConversation(r) : undefined
  }

  updateConversation(id: string, patch: Partial<Omit<Conversation, 'id'>>): void {
    const current = this.getConversation(id)
    if (!current) return
    const c = { ...current, ...patch }
    this.db
      .prepare(
        `UPDATE conversations SET title = ?, character_id = ?, provider_id = ?, model = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(c.title, c.characterId, c.providerId, c.model, c.updatedAt, id)
  }

  listConversations(query?: string): Conversation[] {
    const rows = query
      ? this.db
          .prepare(
            `SELECT DISTINCT c.* FROM conversations c
             LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE c.title LIKE ? OR (m.role = 'user' AND m.parts_json LIKE ?)
             ORDER BY c.updated_at DESC LIMIT 200`
          )
          .all(`%${query}%`, `%${query}%`)
      : this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 200').all()
    return rows.map(rowToConversation)
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  addMessage(m: ChatMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, parts_json, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.id,
        m.conversationId,
        m.role,
        JSON.stringify(m.parts),
        m.raw ? JSON.stringify(m.raw) : null,
        m.createdAt
      )
  }

  getMessages(conversationId: string): ChatMessage[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId)
      .map((r) => ({
        id: String(r.id),
        conversationId: String(r.conversation_id),
        role: r.role as ChatMessage['role'],
        parts: JSON.parse(String(r.parts_json)),
        raw: r.raw_json ? JSON.parse(String(r.raw_json)) : undefined,
        createdAt: Number(r.created_at)
      }))
  }

  deleteMessagesFrom(conversationId: string, messageId: string): void {
    this.db
      .prepare(
        `DELETE FROM messages WHERE conversation_id = ?
         AND seq >= (SELECT seq FROM messages WHERE id = ? AND conversation_id = ?)`
      )
      .run(conversationId, messageId, conversationId)
  }

  close(): void {
    this.db.close()
  }
}

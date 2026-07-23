import { DatabaseSync } from 'node:sqlite';
import type { Todo } from '@example/isomorphic';

// The todo persistence layer, extracted from the backend into its own workspace library.
//
// @example/db is a *source-consumption* package: its package.json `exports` point straight at this
// file — there's no build, no `dist`, no emit. The backend imports `@example/db` and Node's native
// TypeScript support type-strips this source on the fly. It's wired purely by the pnpm
// `workspace:*` link, with no TypeScript project reference — the counterpart to `@example/isomorphic`,
// which is instead compiled to `dist` and consumed via a tsconfig project reference. (The `Todo`
// import here is type-only, so it's erased at runtime: @example/db has no runtime dependencies.)

// A single local SQLite file, created on first run (gitignored) in the running process's cwd —
// i.e. the backend's directory. The `todos` table is created if it doesn't exist yet, so there's
// no separate migration step.
const db = new DatabaseSync('todos.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT    NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);

// node:sqlite returns untyped rows; SQLite has no boolean type, so `completed` is stored as
// 0/1. Coerce a raw row into the shared `Todo` shape (defined in @example/isomorphic).
const toTodo = (row: Record<string, unknown>): Todo => ({
  id: Number(row.id),
  title: String(row.title),
  completed: Boolean(row.completed),
  createdAt: String(row.createdAt),
});

const selectById = db.prepare('SELECT * FROM todos WHERE id = ?');

/** All todos, newest first. */
export function listTodos(): Todo[] {
  return db.prepare('SELECT * FROM todos ORDER BY id DESC').all().map(toTodo);
}

/** A single todo by id, or `undefined` if it doesn't exist. */
export function getTodo(id: number): Todo | undefined {
  const row = selectById.get(id);
  return row ? toTodo(row) : undefined;
}

/** Insert a new todo (title already validated by the caller) and return it. */
export function insertTodo(title: string): Todo {
  const { lastInsertRowid } = db.prepare('INSERT INTO todos (title) VALUES (?)').run(title);
  return toTodo(selectById.get(lastInsertRowid)!);
}

/** Patch a todo's title and/or completed flag; returns the updated todo, or `undefined` if not found. */
export function updateTodo(
  id: number,
  patch: { title?: string; completed?: boolean },
): Todo | undefined {
  const current = getTodo(id);
  if (!current) {
    return undefined;
  }
  const title = patch.title ?? current.title;
  const completed = patch.completed ?? current.completed;
  db.prepare('UPDATE todos SET title = ?, completed = ? WHERE id = ?').run(
    String(title),
    completed ? 1 : 0,
    id,
  );
  return getTodo(id);
}

/** Delete a todo by id (a no-op if it doesn't exist). */
export function deleteTodo(id: number): void {
  db.prepare('DELETE FROM todos WHERE id = ?').run(id);
}

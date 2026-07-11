import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { type Todo, validateNewTodo } from '@example/isomorphic';

const PORT = 3001;

// A single local SQLite file, created on first run (gitignored). The `todos`
// table is created if it doesn't exist yet, so there's no separate migration step.
const db = new DatabaseSync('todos.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT    NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);

// node:sqlite returns untyped rows; SQLite has no boolean type, so `completed`
// is stored as 0/1. Coerce a raw row into the JSON shape the frontend expects.
const toTodo = (row: Record<string, unknown>): Todo => ({
  id: Number(row.id),
  title: String(row.title),
  completed: Boolean(row.completed),
  createdAt: String(row.createdAt),
});

const selectById = db.prepare('SELECT * FROM todos WHERE id = ?');

const app = express();
app.use(express.json());

// Used by devtooie's `waitFor`: the frontend only starts once this returns 200.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/todos', (_req, res) => {
  const rows = db.prepare('SELECT * FROM todos ORDER BY id DESC').all();
  res.json(rows.map(toTodo));
});

app.post('/todos', (req, res) => {
  // Same validation rules the frontend enforces — shared from @example/isomorphic.
  const result = validateNewTodo(req.body);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  const { lastInsertRowid } = db.prepare('INSERT INTO todos (title) VALUES (?)').run(result.title);
  res.status(201).json(toTodo(selectById.get(lastInsertRowid)!));
});

app.patch('/todos/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = selectById.get(id);
  if (!existing) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const current = toTodo(existing);
  const title = req.body?.title ?? current.title;
  const completed = req.body?.completed ?? current.completed;
  db.prepare('UPDATE todos SET title = ?, completed = ? WHERE id = ?').run(
    String(title),
    completed ? 1 : 0,
    id,
  );
  res.json(toTodo(selectById.get(id)!));
});

app.delete('/todos/:id', (req, res) => {
  db.prepare('DELETE FROM todos WHERE id = ?').run(Number(req.params.id));
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`todo api listening on http://localhost:${PORT}`);
});

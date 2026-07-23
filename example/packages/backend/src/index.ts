import express from 'express';
import { validateNewTodo } from '@example/isomorphic';
import { listTodos, insertTodo, updateTodo, deleteTodo } from '@example/db';

const PORT = 3001;

const app = express();
app.use(express.json());

// Used by devtooie's `waitFor`: the frontend only starts once this returns 200.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/todos', (_req, res) => {
  res.json(listTodos());
});

app.post('/todos', (req, res) => {
  // Same validation rules the frontend enforces — shared from @example/isomorphic.
  const result = validateNewTodo(req.body);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json(insertTodo(result.title));
});

app.patch('/todos/:id', (req, res) => {
  const updated = updateTodo(Number(req.params.id), {
    title: req.body?.title,
    completed: req.body?.completed,
  });
  if (!updated) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(updated);
});

app.delete('/todos/:id', (req, res) => {
  deleteTodo(Number(req.params.id));
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`todo api listening on http://localhost:${PORT}`);
});

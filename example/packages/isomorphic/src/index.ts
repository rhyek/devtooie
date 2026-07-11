// The Todo model shared by the backend (validation + response shape) and the frontend
// (types + form constraints). This is the "isomorphic" package: pure, dependency-free
// TypeScript that runs on the Node server and — via its compiled `dist` — in the browser
// bundle. Edit it while devtooie is running and its `tsc --watch` re-emits `dist`, which
// both apps pick up live.

/** Longest a todo title may be. Enforced by the backend, hinted by the frontend's input. */
export const TITLE_MAX_LENGTH = 200;

/** A todo as stored by the backend and rendered by the frontend. */
export interface Todo {
  id: number;
  title: string;
  completed: boolean;
  createdAt: string;
}

export type ValidateResult = { ok: true; title: string } | { ok: false; error: string };

/** Validate + normalize a new-todo request body. Shared so client and server agree on the rules. */
export function validateNewTodo(input: unknown): ValidateResult {
  const title = String((input as { title?: unknown } | null)?.title ?? '').trim();
  if (!title) {
    return { ok: false, error: 'title is required' };
  }
  if (title.length > TITLE_MAX_LENGTH) {
    return { ok: false, error: `title must be ${TITLE_MAX_LENGTH} characters or fewer` };
  }
  return { ok: true, title };
}

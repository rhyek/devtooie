import { getGitBranch } from './lib.js';

export function watchGitBranch(opts: {
  read?: () => string | null;
  intervalMs?: number;
  onChange: (from: string, to: string) => void;
}): () => void {
  const read = opts.read ?? getGitBranch;
  const start = read();
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    const now = read();
    if (start && now && now !== start) {
      fired = true;
      clearInterval(timer);
      opts.onChange(start, now);
    }
  }, opts.intervalMs ?? 2000);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  return () => clearInterval(timer);
}

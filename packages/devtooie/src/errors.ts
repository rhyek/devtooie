export function handleShellError(err: unknown): never {
  const e = err as { stdout?: string; stderr?: string; exitCode?: number };
  if (e?.stdout) {
    console.error(String(e.stdout));
  }
  if (e?.stderr) {
    console.error(String(e.stderr));
  }
  if (!e?.stdout && !e?.stderr) {
    console.error(String(err));
  }
  process.exit(e?.exitCode ?? 1);
}

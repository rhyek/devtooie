import { pool } from './pool.ts';

// Starter rows for an empty database. The `afterReady` callback runs this only when the service
// was just reset (`devtooie infra up --reset`), right after migrate.ts.

const titles = ['Read the devtooie docs', 'Run `pnpm devtooie infra up`', 'Add a todo of your own'];
for (const title of titles) {
  await pool.query('INSERT INTO todos (title) VALUES ($1)', [title]);
}
console.log(`seeded ${titles.length} todos`);
await pool.end();

import { pool } from './pool.ts';

// Creates the schema. devtooie runs this from the `db` service's `afterReady` callback (see
// devtooie.config.ts): on every `devtooie infra up` and every session start, once Postgres
// passes its healthcheck. That is why it is idempotent — most runs find the table already there.

await pool.query(`
  CREATE TABLE IF NOT EXISTS todos (
    id         integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title      text        NOT NULL,
    completed  boolean     NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )
`);
console.log('schema is up to date');
await pool.end();

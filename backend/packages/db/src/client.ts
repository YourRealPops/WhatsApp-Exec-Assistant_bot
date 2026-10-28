import postgres from "postgres";

export type Db = ReturnType<typeof postgres>;

/**
 * Open a Postgres connection pool. Both the API and the worker open their
 * own pool against the same DATABASE_URL.
 */
export function createDb(url: string, opts: { max?: number } = {}): Db {
  return postgres(url, {
    max: opts.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

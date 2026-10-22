import postgres from "postgres";

// Health-check ping: one pooled connection, short timeouts, so /health answers fast even when the
// database is unreachable.
export function makePingDb(databaseUrl: string): () => Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 3, idle_timeout: 30 });
  return async () => {
    await sql`select 1`;
  };
}

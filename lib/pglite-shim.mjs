// Local test shim: makes PGlite look like the Neon tagged-template client.
// Only loaded when LOCAL_PGLITE=1 (never on Vercel).
import { PGlite } from "@electric-sql/pglite";

export function makeSql() {
  const pg = new PGlite(process.env.PGLITE_DIR || undefined);
  return async (strings, ...values) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
    const res = await pg.query(text, values);
    return res.rows;
  };
}

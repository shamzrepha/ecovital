// Database access (Neon serverless Postgres). Schema is created automatically on first use.

import { neon } from "@neondatabase/serverless";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export type Row = Record<string, any>;
export type Sql = (strings: TemplateStringsArray, ...values: any[]) => Promise<Row[]>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS devices (
     id text PRIMARY KEY,
     name text NOT NULL,
     location text,
     lat double precision,
     lng double precision,
     simulated boolean NOT NULL DEFAULT false,
     created_at timestamptz NOT NULL DEFAULT now(),
     last_seen timestamptz,
     meta jsonb NOT NULL DEFAULT '{}'::jsonb,
     state jsonb NOT NULL DEFAULT '{}'::jsonb
   )`,
  `CREATE TABLE IF NOT EXISTS readings (
     device_id text NOT NULL,
     ts timestamptz NOT NULL,
     dust real, air real, temp real, hum real,
     flags text,
     PRIMARY KEY (device_id, ts)
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id bigserial PRIMARY KEY,
     device_id text NOT NULL,
     ts timestamptz NOT NULL DEFAULT now(),
     kind text NOT NULL,
     metric text,
     status text,
     severity int NOT NULL DEFAULT 0,
     message text NOT NULL,
     spoken text,
     spoken_flag boolean NOT NULL DEFAULT false,
     source text,
     data jsonb,
     audio_b64 text,
     outcome text
   )`,
  `CREATE INDEX IF NOT EXISTS events_dev_ts ON events (device_id, ts DESC)`,
  `CREATE TABLE IF NOT EXISTS forecasts (
     id bigserial PRIMARY KEY,
     device_id text NOT NULL,
     metric text NOT NULL,
     made_at timestamptz NOT NULL,
     target_at timestamptz NOT NULL,
     predicted real,
     baseline real,
     actual real,
     confidence text,
     trend text,
     resolved boolean NOT NULL DEFAULT false,
     void boolean NOT NULL DEFAULT false
   )`,
  `CREATE INDEX IF NOT EXISTS forecasts_dev_target ON forecasts (device_id, target_at)`,
  `CREATE TABLE IF NOT EXISTS users (
     id text PRIMARY KEY,
     email text UNIQUE NOT NULL,
     name text NOT NULL,
     role text NOT NULL DEFAULT 'owner',
     prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS rooms (
     id text PRIMARY KEY,
     owner_id text NOT NULL,
     name text NOT NULL,
     type text NOT NULL DEFAULT 'classroom',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS pods (
     device_id text PRIMARY KEY,
     claimed_by text,
     claimed_at timestamptz,
     room_id text,
     profile text NOT NULL DEFAULT 'classroom',
     volume int NOT NULL DEFAULT 100,
     muted boolean NOT NULL DEFAULT false,
     nickname text,
     device_token text,
     token_delivered boolean NOT NULL DEFAULT false,
     share_token text UNIQUE,
     weights jsonb NOT NULL DEFAULT '{"air":25,"dust":25,"temp":25,"hum":25}'::jsonb
   )`,
  `CREATE TABLE IF NOT EXISTS thresholds_override (
     pod text NOT NULL,
     metric text NOT NULL,
     watch_high real,
     bad_high real,
     watch_low real,
     bad_low real,
     PRIMARY KEY (pod, metric)
   )`,
  `CREATE TABLE IF NOT EXISTS firmware_releases (
     id bigserial PRIMARY KEY,
     version text UNIQUE NOT NULL,
     url text NOT NULL,
     notes text,
     channel text NOT NULL DEFAULT 'stable',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS pod_contact (
     device_id text PRIMARY KEY,
     claim text,
     result text NOT NULL,
     fw text,
     last_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS firmware_blobs (
     version text PRIMARY KEY,
     size integer NOT NULL,
     data_b64 text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS pod_firmware_target (
     device_id text PRIMARY KEY,
     version text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
     id bigserial PRIMARY KEY,
     user_id text NOT NULL,
     endpoint text UNIQUE NOT NULL,
     keys jsonb NOT NULL DEFAULT '{}'::jsonb,
     prefs jsonb NOT NULL DEFAULT '{"metrics":{"air":true,"dust":true,"temp":true,"hum":true},"quietStart":"22:00","quietEnd":"06:30","quietEnabled":false}'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS insights (
     id bigserial PRIMARY KEY,
     device_id text NOT NULL,
     period text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     summary_json jsonb NOT NULL,
     text text NOT NULL,
     source text NOT NULL DEFAULT 'template'
   )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
     id bigserial PRIMARY KEY,
     user_id text NOT NULL,
     device_id text NOT NULL,
     role text NOT NULL,
     text text NOT NULL,
     ts timestamptz NOT NULL DEFAULT now(),
     data_refs jsonb NOT NULL DEFAULT '[]'::jsonb
   )`,
  `CREATE TABLE IF NOT EXISTS notifications_log (
     id bigserial PRIMARY KEY,
     user_id text,
     device_id text NOT NULL,
     event_id bigint,
     channel text NOT NULL DEFAULT 'web_push',
     title text,
     body text,
     sent_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS claim_attempts (
     user_id text NOT NULL,
     code text NOT NULL,
     fails int NOT NULL DEFAULT 0,
     locked_until timestamptz,
     PRIMARY KEY (user_id, code)
   )`,
  `CREATE TABLE IF NOT EXISTS ai_logs (
     id bigserial PRIMARY KEY,
     ts timestamptz NOT NULL DEFAULT now(),
     device_id text,
     kind text NOT NULL,
     inputs jsonb NOT NULL,
     output jsonb NOT NULL,
     source text NOT NULL
   )`,
];

let ready: Promise<Sql> | null = null;

async function open(): Promise<Sql> {
  let sql: Sql;
  const url = process.env.DATABASE_URL;
  if (process.env.LOCAL_PGLITE === "1" || !url) {
    // Zero-config fallback when DATABASE_URL is not set (or in local testing).
    try {
      const { PGlite } = await import("@electric-sql/pglite");
      const pg = new PGlite(process.env.PGLITE_DIR || undefined);
      sql = async (strings: TemplateStringsArray, ...values: any[]) => {
        let text = strings[0];
        for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
        const res = await pg.query(text, values);
        return res.rows as Row[];
      };
    } catch {
      const shim = pathToFileURL(join(process.cwd(), "lib", "pglite-shim.mjs")).href;
      const m: any = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ shim);
      sql = m.makeSql();
    }
  } else {
    sql = neon(url) as unknown as Sql;
  }
  for (const stmt of SCHEMA) {
    const strings = Object.assign([stmt], { raw: [stmt] }) as unknown as TemplateStringsArray;
    await sql(strings);
  }
  return sql;
}

export function db(): Promise<Sql> {
  if (!ready) ready = open().catch((e) => { ready = null; throw e; });
  return ready;
}

export const iso = (ms: number) => new Date(ms).toISOString();

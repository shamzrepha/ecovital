import { neon } from '@neondatabase/serverless';
import fs from 'fs';

const env = fs.readFileSync('.env.production.local', 'utf8');
const match = env.match(/DATABASE_URL_UNPOOLED="?([^"\r\n]+)"?/) || env.match(/DATABASE_URL="?([^"\r\n]+)"?/);
const sql = neon(match[1]);

async function run() {
  const dev = await sql`SELECT id, name, meta, last_seen FROM devices WHERE id = 'ecovital-66f3a8'`;
  console.log('Device:', dev[0]);
  const targets = await sql`SELECT * FROM pod_firmware_target`;
  console.log('Targets:', targets);
  const releases = await sql`SELECT * FROM firmware_releases WHERE version = '2.8'`;
  console.log('Release 2.8:', releases[0]);
}

run();

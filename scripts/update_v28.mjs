import { neon } from '@neondatabase/serverless';
import fs from 'fs';
import path from 'path';

// Read database URL from .env.production.local or .env.local
let envFile = '';
if (fs.existsSync('.env.production.local')) {
  envFile = fs.readFileSync('.env.production.local', 'utf8');
} else if (fs.existsSync('.env.local')) {
  envFile = fs.readFileSync('.env.local', 'utf8');
}
const match = envFile.match(/DATABASE_URL_UNPOOLED="?([^"\r\n]+)"?/) || envFile.match(/DATABASE_URL="?([^"\r\n]+)"?/);
if (!match) {
  console.error('No database URL found');
  process.exit(1);
}

const dbUrl = match[1];
const sql = neon(dbUrl);

async function main() {
  const otaPath = path.resolve('public/firmware/2.8.bin');
  if (!fs.existsSync(otaPath)) {
    console.error('2.8.bin does not exist yet at', otaPath);
    process.exit(1);
  }

  const buf = fs.readFileSync(otaPath);
  const b64 = buf.toString('base64');
  console.log(`Read 2.8.bin: ${buf.length} bytes`);

  // Insert or update firmware_blobs
  await sql`
    INSERT INTO firmware_blobs (version, size, data_b64)
    VALUES ('2.8', ${buf.length}, ${b64})
    ON CONFLICT (version) DO UPDATE
    SET size = EXCLUDED.size, data_b64 = EXCLUDED.data_b64
  `;
  console.log('firmware_blobs updated for version 2.8');

  // Update pod_firmware_target for ecovital-66f3a8
  await sql`
    INSERT INTO pod_firmware_target (device_id, version, updated_at)
    VALUES ('ecovital-66f3a8', '2.8', NOW())
    ON CONFLICT (device_id) DO UPDATE
    SET version = '2.8', updated_at = NOW()
  `;
  console.log('pod_firmware_target updated for ecovital-66f3a8 -> 2.8');

  // Verify
  const rows = await sql`SELECT * FROM pod_firmware_target WHERE device_id = 'ecovital-66f3a8'`;
  console.log('Target row:', rows);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

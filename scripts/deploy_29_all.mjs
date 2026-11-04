import { neon } from '@neondatabase/serverless';
import fs from 'fs';
import path from 'path';

const env = fs.readFileSync('.env.production.local', 'utf8');
const match = env.match(/DATABASE_URL_UNPOOLED="?([^"\r\n]+)"?/) || env.match(/DATABASE_URL="?([^"\r\n]+)"?/);
if (!match) {
  console.error('No DB URL');
  process.exit(1);
}

const sql = neon(match[1]);

async function run() {
  const otaPath = path.resolve('public/firmware/2.9.bin');
  if (!fs.existsSync(otaPath)) {
    console.error('2.9.bin does not exist yet at', otaPath);
    process.exit(1);
  }

  const buf = fs.readFileSync(otaPath);
  const b64 = buf.toString('base64');
  console.log(`Read 2.9.bin: ${buf.length} bytes`);

  // 1. Upload to firmware_blobs
  await sql`
    INSERT INTO firmware_blobs (version, size, data_b64)
    VALUES ('2.9', ${buf.length}, ${b64})
    ON CONFLICT (version) DO UPDATE
    SET size = EXCLUDED.size, data_b64 = EXCLUDED.data_b64
  `;
  console.log('firmware_blobs updated for version 2.9');

  // 2. Insert/update firmware_releases
  const releaseUrl = 'https://ecovital-phi.vercel.app/firmware/2.9.bin';
  await sql`
    INSERT INTO firmware_releases (version, url, notes, channel)
    VALUES ('2.9', ${releaseUrl}, 'v2.9 - Sensor ADC anti-ghosting, one-shot alarm trigger, extended quiet window', 'stable')
    ON CONFLICT (version) DO UPDATE
    SET url = EXCLUDED.url, notes = EXCLUDED.notes, channel = EXCLUDED.channel
  `;
  console.log('firmware_releases updated with 2.9 pointing to:', releaseUrl);

  // 3. Queue for all devices
  const devices = await sql`SELECT id, name, simulated FROM devices`;
  for (const d of devices) {
    await sql`
      INSERT INTO pod_firmware_target (device_id, version, updated_at)
      VALUES (${d.id}, '2.9', NOW())
      ON CONFLICT (device_id) DO UPDATE
      SET version = '2.9', updated_at = NOW()
    `;
    console.log(` -> Set target for ${d.id} (${d.name}) to 2.9`);
  }

  // 4. Verify targets
  const targets = await sql`SELECT * FROM pod_firmware_target`;
  console.log('Targets:', targets);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});

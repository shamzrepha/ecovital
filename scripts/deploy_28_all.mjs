import { neon } from '@neondatabase/serverless';
import fs from 'fs';

const env = fs.readFileSync('.env.production.local', 'utf8');
const match = env.match(/DATABASE_URL_UNPOOLED="?([^"\r\n]+)"?/) || env.match(/DATABASE_URL="?([^"\r\n]+)"?/);
if (!match) {
  console.error('No DB URL');
  process.exit(1);
}

const sql = neon(match[1]);

async function run() {
  console.log('--- Devices in DB ---');
  const devices = await sql`SELECT id, name, location, simulated, last_seen FROM devices`;
  console.log('Devices count:', devices.length);
  for (const d of devices) {
    console.log(`Device: ${d.id} | Name: ${d.name} | Simulated: ${d.simulated} | Last seen: ${d.last_seen}`);
  }

  console.log('\n--- Firmware Releases in DB ---');
  const releases = await sql`SELECT * FROM firmware_releases`;
  console.log(releases);

  // 1. Ensure firmware_releases has 2.8
  const releaseUrl = 'https://ecovital-phi.vercel.app/firmware/2.8.bin';
  await sql`
    INSERT INTO firmware_releases (version, url, notes, channel)
    VALUES ('2.8', ${releaseUrl}, 'v2.8 - Real-time 3s streaming, debounce & glitch filter', 'stable')
    ON CONFLICT (version) DO UPDATE
    SET url = EXCLUDED.url, notes = EXCLUDED.notes, channel = EXCLUDED.channel
  `;
  console.log('\nInserted/Updated firmware_releases with 2.8 pointing to:', releaseUrl);

  // 2. Queue for all devices
  const realDevices = devices.filter(d => !d.simulated);
  console.log(`\nQueueing 2.8 target for ${realDevices.length} non-simulated pods (and all devices):`);
  for (const d of devices) {
    await sql`
      INSERT INTO pod_firmware_target (device_id, version, updated_at)
      VALUES (${d.id}, '2.8', NOW())
      ON CONFLICT (device_id) DO UPDATE
      SET version = '2.8', updated_at = NOW()
    `;
    console.log(` -> Set target for ${d.id} to 2.8`);
  }

  // 3. Verify pod_firmware_target
  console.log('\n--- Current pod_firmware_target ---');
  const targets = await sql`SELECT * FROM pod_firmware_target`;
  console.log(targets);

  // 4. Test the join used in ingest
  console.log('\n--- Ingest Join Verification ---');
  for (const d of devices) {
    const otaRows = await sql`
      SELECT f.version, f.url FROM pod_firmware_target t
      JOIN firmware_releases f ON f.version = t.version
      WHERE t.device_id = ${d.id} LIMIT 1
    `;
    console.log(`Pod ${d.id}:`, otaRows[0] || 'No OTA match');
  }
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});

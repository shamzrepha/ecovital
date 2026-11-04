import { neon } from '@neondatabase/serverless';
import fs from 'fs';

const env = fs.readFileSync('.env.production.local', 'utf8');
const match = env.match(/DATABASE_URL_UNPOOLED="?([^"\r\n]+)"?/) || env.match(/DATABASE_URL="?([^"\r\n]+)"?/);
const sql = neon(match[1]);

async function run() {
  const devs = await sql`SELECT id, name, meta->>'fw' as fw, last_seen, simulated FROM devices`;
  console.log('All devices in database:', devs);

  // Ensure default target 2.9 exists in pod_firmware_target for all non-simulated pods if not yet at 2.9
  for (const d of devs) {
    if (!d.simulated) {
      if (d.fw !== '2.9') {
        await sql`
          INSERT INTO pod_firmware_target (device_id, version, updated_at)
          VALUES (${d.id}, '2.9', NOW())
          ON CONFLICT (device_id) DO UPDATE SET version = '2.9', updated_at = NOW()
        `;
        console.log(`Queued 2.9 for ${d.id}`);
      } else {
        console.log(`Device ${d.id} is ALREADY on fw 2.9!`);
      }
    }
  }

  // Also check all releases
  const rels = await sql`SELECT version, url, channel, created_at FROM firmware_releases ORDER BY created_at DESC LIMIT 5`;
  console.log('\nLatest firmware_releases:', rels);
}

run();

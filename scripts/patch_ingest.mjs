import fs from 'fs';

let content = fs.readFileSync('lib/ingest.ts', 'utf8');

// 1. Tag deduplication: gas alarms always use `gas-${id}`
content = content.replace(
  'tag: `pod-${id}`,\r\n            isGasAlarm,',
  'tag: isGasAlarm ? `gas-${id}` : `pod-${id}`,\r\n            isGasAlarm,'
);
// Also in case LF without CR
content = content.replace(
  'tag: `pod-${id}`,\n            isGasAlarm,',
  'tag: isGasAlarm ? `gas-${id}` : `pod-${id}`,\n            isGasAlarm,'
);

// 2. Mark event data with alarm: "gas" so subsequent queries find it
content = content.replace(
  'if (isGasAlarm) pushedGasAlarm = true;',
  'if (isGasAlarm) { pushedGasAlarm = true; (data as any).alarm = "gas"; }'
);

// 3. Deduplicate pod-level alarm query against rule triggers from the last 2 minutes
content = content.replace(
  "SELECT id FROM events WHERE device_id = ${id} AND data->>'alarm' = 'gas' AND ts > ${iso(now - 120_000)}::timestamptz LIMIT 1",
  "SELECT id FROM events WHERE device_id = ${id} AND (data->>'alarm' = 'gas' OR (metric = 'air' AND status = 'bad-low')) AND ts > ${iso(now - 120_000)}::timestamptz LIMIT 1"
);

fs.writeFileSync('lib/ingest.ts', content, 'utf8');
console.log('Successfully patched lib/ingest.ts');

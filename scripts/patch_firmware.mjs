import fs from 'fs';

let content = fs.readFileSync('firmware/ecovital_pod/ecovital_pod.ino', 'utf8');

// 1. Version bump to 2.9
content = content.replace('#define FW_VERSION "2.8"', '#define FW_VERSION "2.9"');
content = content.replace('#define FW_VERSION "2.7"', '#define FW_VERSION "2.9"');

// 2. Inter-sample delay in takePulse
content = content.replace(
  'delayMicroseconds(35); // Allow ADC supply rail to settle after LED high\n  int m1 = analogReadMilliVolts(PIN_MQ);\n  int m2 = analogReadMilliVolts(PIN_MQ);\n  int m3 = analogReadMilliVolts(PIN_MQ);',
  'delayMicroseconds(60); // Allow ADC supply rail to settle after LED high\n  int m1 = analogReadMilliVolts(PIN_MQ);\n  delayMicroseconds(40);\n  int m2 = analogReadMilliVolts(PIN_MQ);\n  delayMicroseconds(40);\n  int m3 = analogReadMilliVolts(PIN_MQ);'
);
content = content.replace(
  'delayMicroseconds(35); // Allow ADC supply rail to settle after LED high\r\n  int m1 = analogReadMilliVolts(PIN_MQ);\r\n  int m2 = analogReadMilliVolts(PIN_MQ);\r\n  int m3 = analogReadMilliVolts(PIN_MQ);',
  'delayMicroseconds(60); // Allow ADC supply rail to settle after LED high\r\n  int m1 = analogReadMilliVolts(PIN_MQ);\r\n  delayMicroseconds(40);\r\n  int m2 = analogReadMilliVolts(PIN_MQ);\r\n  delayMicroseconds(40);\r\n  int m3 = analogReadMilliVolts(PIN_MQ);'
);

// 3. gasStep threshold: realistic emergency drop, 3.0s sustained filter, and 25s debounce cooldown
content = content.replace(
  'bool bad = test || air < GAS_LOW_LEVEL || air <= airRef - GAS_DROP_POINTS;',
  'bool bad = test || air < 25.0f || (air < 35.0f && airRef >= 50.0f && air <= airRef - 20.0f);'
);
content = content.replace(
  'if (now - gasLowSince >= (test ? 0 : 2500)) {',
  'if (now - gasLowSince >= (test ? 0 : 3000)) {'
);
content = content.replace(
  'bool ok = !test && minHoldPassed && air >= GAS_LOW_LEVEL + 8 && air >= airRef - 6.0f;',
  'bool ok = !test && minHoldPassed && air >= 45.0f && air >= airRef - 8.0f;'
);
content = content.replace(
  'gasCooldownUntil = now + 15000UL; // 15-second debounce cooldown',
  'gasCooldownUntil = now + 25000UL; // 25-second debounce cooldown\r\n      airRef = air;'
);
content = content.replace(
  'gasCooldownUntil = now + 15000UL; // 15-second debounce cooldown\n',
  'gasCooldownUntil = now + 25000UL; // 25-second debounce cooldown\n      airRef = air;\n'
);

// 4. In loop: extend audioQuiet to 2500ms
content = content.replace(
  'if (speaking) audioQuietUntil = now + 1500;',
  'if (speaking) audioQuietUntil = now + 2500;'
);

// 5. In postBatch: one-shot gasTrig so alarm is sent once per trigger
content = content.replace(
  '(gasAlarm || causeId == C_SMOKE) ? ",\\"alarm\\":\\"gas\\"" : "",',
  '(gasTrig || causeId == C_SMOKE) ? (gasTrig = false, ",\\"alarm\\":\\"gas\\"") : "",'
);

fs.writeFileSync('firmware/ecovital_pod/ecovital_pod.ino', content, 'utf8');
console.log('Successfully patched firmware/ecovital_pod/ecovital_pod.ino to v2.9');

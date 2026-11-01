// Admin gate for actions that change what every pod runs (publishing firmware).
// Uses ADMIN_KEY if set, otherwise the DEVICE_KEY (defaulting to the firmware 1.4 built-in key).
export const DEFAULT_DEVICE_KEY = "evk_6450a3caa5e01e24638ef4e6";

export function getDeviceKey(): string {
  return process.env.DEVICE_KEY || DEFAULT_DEVICE_KEY;
}

export function adminOk(req: Request): boolean {
  const expected = process.env.ADMIN_KEY || getDeviceKey();
  if (!expected) return false;
  const given = req.headers.get("x-admin-key") ?? "";
  return given.length > 0 && given === expected;
}

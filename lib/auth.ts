// Admin gate for actions that change what every pod runs (publishing firmware).
// Uses ADMIN_KEY if set, otherwise the DEVICE_KEY. If neither is configured nothing is allowed.
export function adminOk(req: Request): boolean {
  const expected = process.env.ADMIN_KEY || process.env.DEVICE_KEY || "";
  if (!expected) return false;
  const given = req.headers.get("x-admin-key") ?? "";
  return given.length > 0 && given === expected;
}

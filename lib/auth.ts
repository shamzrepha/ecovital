// Admin gate for actions that change what every pod runs (publishing firmware, downloading the sketch).
// Only a signed-in account with the admin role may do these. The first account created is the admin.
import { getSessionUser } from "./session.ts";

export async function adminOk(req: Request): Promise<boolean> {
  try {
    const u = await getSessionUser(req);
    return !!u && u.role === "admin";
  } catch {
    return false;
  }
}

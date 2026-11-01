import { db } from "@/lib/db";
import NodeView from "@/components/NodeView";
import Link from "next/link";

export default async function SharePodPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const sql = await db();
  const rows = await sql`SELECT device_id FROM pods WHERE share_token = ${token} LIMIT 1`;
  const podId = rows[0]?.device_id ?? null;

  if (!podId) {
    return (
      <div className="wrap" style={{ paddingTop: 32 }}>
        <div className="banner">
          Invalid or expired read-only share link. <Link href="/">Return to EcoVital Home</Link>.
        </div>
      </div>
    );
  }

  return <NodeView id={podId} readOnly={true} shareToken={token} />;
}

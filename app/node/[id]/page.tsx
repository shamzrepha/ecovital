import NodeView from "@/components/NodeView";

export default async function NodePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NodeView id={decodeURIComponent(id)} />;
}

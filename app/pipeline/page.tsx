import { redirect } from "next/navigation";
import { currentUser } from "../lib/session";
import { firm } from "../../firm.config";
import PipelineBoard from "../components/pipeline/PipelineBoard";

export const metadata = { title: `Pipeline | ${firm.productName}` };

export default async function PipelinePage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return <PipelineBoard stages={firm.dealStages} isOwner={user.role === "owner"} />;
}

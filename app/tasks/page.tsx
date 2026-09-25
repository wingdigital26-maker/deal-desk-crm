import { redirect } from "next/navigation";
import { currentUser } from "../lib/session";
import { firm } from "../../firm.config";
import TaskList from "../components/pipeline/TaskList";

export const metadata = { title: `Tasks | ${firm.productName}` };

export default async function TasksPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return <TaskList />;
}

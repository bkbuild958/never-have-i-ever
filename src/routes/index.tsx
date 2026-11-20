import { createFileRoute } from "@tanstack/react-router";
import { NeverTable } from "@/components/never-table";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <NeverTable />;
}

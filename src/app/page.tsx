import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth/current";

export const dynamic = "force-dynamic";

export default async function Home() {
  redirect((await currentSession()) ? "/dashboard" : "/login");
}

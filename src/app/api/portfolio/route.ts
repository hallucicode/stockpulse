import { NextResponse } from "next/server";
import { getPortfolio } from "@/lib/actions";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getPortfolio();
    return NextResponse.json(data);
  } catch (err) {
    log.error("api.portfolio", "fetch.error", { error: err });
    return NextResponse.json({ error: "Failed to fetch portfolio" }, { status: 500 });
  }
}

// app/api/sequences/route.ts
import { NextRequest } from "next/server";
import { getBos737Dec2025Packet } from "@/lib/bidData";

export async function GET(req: NextRequest) {
  const packet = getBos737Dec2025Packet();

  const { searchParams } = new URL(req.url);

  const minDays = Number(searchParams.get("minDays") ?? 1);
  const maxDays = Number(searchParams.get("maxDays") ?? 7);
  const startDayOfWeek = searchParams.get("startDayOfWeek"); // "MO", "TU", etc.

  // Basic sanity check: make sure sequences exist
  const allSequences: any[] = packet.sequences ?? [];

  const filtered = allSequences.filter((seq) => {
    const days = seq.dutyDays?.length ?? 0;
    if (days < minDays || days > maxDays) return false;

    if (startDayOfWeek) {
      const codes: string[] = seq.startDays?.dayOfWeekCodes ?? [];
      if (!codes.includes(startDayOfWeek)) return false;
    }

    return true;
  });

  return Response.json({
    count: filtered.length,
    sequences: filtered,
  });
}

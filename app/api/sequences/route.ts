// app/api/sequences/route.ts
import { NextRequest } from "next/server";
import { getBos737Dec2025Packet } from "@/lib/bidData";

export async function GET(_req: NextRequest) {
  const packet = getBos737Dec2025Packet();
  const sequences = packet.sequences ?? [];

  return Response.json({
    count: sequences.length,
    sequences,
  });
}

// app/api/sequences/route.ts
import { getBos737Dec2025Packet } from "@/lib/bidData";

export async function GET() {
  const packet = getBos737Dec2025Packet();
  const sequences = packet.sequences ?? [];

  return Response.json({
    count: sequences.length,
    sequences,
  });
}

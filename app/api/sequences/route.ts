import { NextResponse } from "next/server";
import { getBos737Dec2025Packet } from "@/lib/bidData";

function parseNumberParam(value: string | null) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function GET(request: Request) {
  const packet = getBos737Dec2025Packet();
  const sequences = Array.isArray(packet.sequences) ? packet.sequences : [];

  const searchParams = new URL(request.url).searchParams;
  const minDays = parseNumberParam(searchParams.get("minDays"));
  const maxDays = parseNumberParam(searchParams.get("maxDays"));
  const startDayOfWeek = searchParams.get("startDayOfWeek");

  const filteredSequences = sequences.filter((sequence) => {
    const dutyDaysCount = Array.isArray((sequence as { dutyDays?: unknown }).dutyDays)
      ? ((sequence as { dutyDays?: unknown[] }).dutyDays?.length ?? 0)
      : 0;

    if (minDays !== null && dutyDaysCount < minDays) {
      return false;
    }

    if (maxDays !== null && dutyDaysCount > maxDays) {
      return false;
    }

    if (startDayOfWeek) {
      const dayOfWeekCodes = Array.isArray(
        (sequence as { startDays?: { dayOfWeekCodes?: unknown } }).startDays?.dayOfWeekCodes
      )
        ? ((sequence as { startDays?: { dayOfWeekCodes?: string[] } }).startDays?.dayOfWeekCodes ?? [])
        : [];

      if (!dayOfWeekCodes.includes(startDayOfWeek)) {
        return false;
      }
    }

    return true;
  });

  return NextResponse.json(filteredSequences);
}

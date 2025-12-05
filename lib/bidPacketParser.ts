import type { PDFParseOptions, PDFParseResult } from "pdf-parse";

type PdfParseFn = (
  data: Buffer | Uint8Array | ArrayBuffer | string,
  options?: PDFParseOptions,
) => Promise<PDFParseResult>;

let cachedPdfParse: PdfParseFn | null = null;

async function loadPdfParse() {
  if (!cachedPdfParse) {
    const mod = await import("pdf-parse");
    cachedPdfParse =
      (mod as { default?: PdfParseFn }).default ?? ((mod as unknown) as PdfParseFn);
  }
  return cachedPdfParse;
}

export type UploadedBidPacket = {
  metadata: {
    base: string;
    fleet: string;
    month: string;
    year: number;
    bid_period_start: string;
    bid_period_end: string;
    source_document: string;
  };
  sequences: UploadedSequence[];
};

export type UploadedSequence = {
  sequence_number: number;
  position: string;
  length_days: number;
  spanish_operation: boolean;
  notes: string | null;
  calendar: {
    start_dates: string[];
    display_range_start: string;
    display_range_end: string;
  };
  totals: {
    block_time: string | null;
    credit_time: string | null;
    tafb: string | null;
  };
  duties: UploadedDuty[];
};

export type UploadedDuty = {
  duty_index: number;
  report_local: string | null;
  release_local: string | null;
  legs: UploadedLeg[];
  layover: {
    station: string | null;
    hotel_name: string | null;
    hotel_phone: string | null;
    transport_name: string | null;
    transport_phone: string | null;
    ground_rest: string | null;
  } | null;
};

export type UploadedLeg = {
  leg_index: number;
  equip_code: string | null;
  flight_number: string | null;
  dep_station: string | null;
  arr_station: string | null;
  dep_local: string | null;
  arr_local: string | null;
  block_time: string | null;
  ground_time: string | null;
  meal: string | null;
};

type SequencePositionCounts = {
  [position: string]: number;
};

type FlightLeg = {
  raw: string;
  day?: string;
  date?: string;
  equipment?: string;
  flightNumber?: string;
  departureStation?: string;
  departureTime?: string;
  meal?: string;
  arrivalStation?: string;
  arrivalTime?: string;
  blockTime?: string;
  remarks?: string;
};

type SequenceDutyDay = {
  rawLines: string[];
  reportLine?: string;
  reportTime?: string;
  calendarDay?: string;
  releaseLine?: string;
  releaseTime?: string;
  hotelLayover?: string;
  summary?: string;
  legs: FlightLeg[];
};

type SequenceRecord = {
  sequenceNumber: string;
  instancesInMonth?: number;
  positions?: SequencePositionCounts;
  totals?: {
    credit?: number;
    dutyHours?: number;
    blockHours?: number;
  };
  dutyDays: SequenceDutyDay[];
  rawLines: string[];
};

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

function splitIntoPages(rawText: string): string[] {
  const normalized = rawText.replace(/\r\n/g, "\n");
  const pages = normalized.split(/\f+/);
  return pages
    .map((page) => page.trim())
    .filter(Boolean);
}

function splitSequences(text: string): string[][] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sequences: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    const isSeqStart = /^SEQ\b/.test(line);
    if (isSeqStart) {
      if (current.length) {
        sequences.push(current);
      }
      current = [line];
      continue;
    }

    if (current.length) {
      current.push(line);
      if (/\bTTL\b/.test(line)) {
        sequences.push(current);
        current = [];
      }
    }
  }

  if (current.length) {
    sequences.push(current);
  }

  return sequences;
}

function parseSequenceHeader(headerLine: string): {
  sequenceNumber: string;
  instancesInMonth?: number;
  positions?: SequencePositionCounts;
} {
  const tokens = headerLine.split(/\s+/);
  const sequenceNumber = tokens[1] || tokens[0].replace(/[^0-9]/g, "");
  let instancesInMonth: number | undefined;
  const positions: SequencePositionCounts = {};

  for (let i = 2; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^\d+$/.test(token) && instancesInMonth === undefined) {
      instancesInMonth = Number(token);
      continue;
    }
    const positionMatch = /^(CA|FO|RL|AP|RS)(\d+)/.exec(token);
    if (positionMatch) {
      positions[positionMatch[1]] = Number(positionMatch[2]);
    }
  }

  return {
    sequenceNumber,
    instancesInMonth,
    positions: Object.keys(positions).length ? positions : undefined,
  };
}

function parseTotals(line: string): SequenceRecord["totals"] | undefined {
  const totals: NonNullable<SequenceRecord["totals"]> = {};
  const credit = /TTL\s*(\d+(?:\.\d+)?)/.exec(line);
  if (credit) {
    totals.credit = Number(credit[1]);
  }
  const duty = /DUTY\s*(\d+(?:\.\d+)?)/i.exec(line);
  if (duty) {
    totals.dutyHours = Number(duty[1]);
  }
  const block = /BLK\s*(\d+(?:\.\d+)?)/i.exec(line);
  if (block) {
    totals.blockHours = Number(block[1]);
  }
  return Object.keys(totals).length ? totals : undefined;
}

function parseReport(line: string): { reportLine: string; reportTime?: string } {
  const match = /RPT\s+([0-9]{3,4}\/[0-9]{3,4}|[0-9]{3,4})/.exec(line);
  return { reportLine: line, reportTime: match ? match[1] : undefined };
}

function parseRelease(line: string): { releaseLine: string; releaseTime?: string } {
  const match = /RLS\s+([0-9]{3,4}\/[0-9]{3,4}|[0-9]{3,4})/.exec(line);
  return { releaseLine: line, releaseTime: match ? match[1] : undefined };
}

function parseFlightLeg(line: string): FlightLeg {
  const tokens = line.split(/\s+/).filter(Boolean);
  const leg: FlightLeg = { raw: line };
  let idx = 0;

  if (tokens[idx]) leg.day = tokens[idx++];
  if (tokens[idx]) leg.date = tokens[idx++];
  if (tokens[idx]) leg.equipment = tokens[idx++];
  if (tokens[idx]) leg.flightNumber = tokens[idx++];
  if (tokens[idx]) leg.departureStation = tokens[idx++];
  if (tokens[idx]) leg.departureTime = tokens[idx++];

  if (tokens[idx] && /^[A-Z]$/.test(tokens[idx])) {
    leg.meal = tokens[idx];
    idx += 1;
  }

  if (tokens[idx]) leg.arrivalStation = tokens[idx++];
  if (tokens[idx]) leg.arrivalTime = tokens[idx++];

  if (tokens[idx] && /^\d+(?:\.\d+)?/.test(tokens[idx])) {
    leg.blockTime = tokens[idx];
    idx += 1;
  }

  if (tokens[idx]) {
    leg.remarks = tokens.slice(idx).join(" ");
  }

  return leg;
}

function isLegLine(line: string): boolean {
  return /^\d+\s+\d+\/\d+\s+\d+\s+\d+/.test(line);
}

function isHotelLine(line: string): boolean {
  return /HOTEL/i.test(line);
}

function parseDutyDays(lines: string[]): SequenceDutyDay[] {
  const duties: SequenceDutyDay[] = [];
  let current: SequenceDutyDay | null = null;
  let currentDayNumber: string | null = null;

  const startNewDutyDay = () => {
    current = { rawLines: [], legs: [] };
    currentDayNumber = null;
  };

  const finalizeCurrentDay = () => {
    if (current) {
      duties.push(current);
      current = null;
      currentDayNumber = null;
    }
  };

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      continue;
    }

    if (/^RPT\b/.test(trimmedLine)) {
      if (!current) {
        startNewDutyDay();
      } else if (current && current.reportLine) {
        finalizeCurrentDay();
        startNewDutyDay();
      }

      const report = parseReport(trimmedLine);
      current.reportLine = report.reportLine;
      current.reportTime = report.reportTime;
      current.rawLines.push(trimmedLine);
      continue;
    }

    const legMatch = isLegLine(trimmedLine) ? /^(\d+)/.exec(trimmedLine) : null;
    if (legMatch) {
      const legDay = legMatch[1];

      if (!current) {
        startNewDutyDay();
      } else if (currentDayNumber && legDay !== currentDayNumber) {
        finalizeCurrentDay();
        startNewDutyDay();
      }

      currentDayNumber = currentDayNumber || legDay;
      const leg = parseFlightLeg(trimmedLine);
      current.legs.push(leg);
      if (!current.calendarDay && leg.date) {
        current.calendarDay = leg.date;
      }
      current.rawLines.push(trimmedLine);
      continue;
    }

    if (/^RLS\b/.test(trimmedLine)) {
      if (!current) {
        startNewDutyDay();
      }
      const release = parseRelease(trimmedLine);
      current.releaseLine = release.releaseLine;
      current.releaseTime = release.releaseTime;
      current.rawLines.push(trimmedLine);
      continue;
    }

    if (isHotelLine(trimmedLine)) {
      if (!current) {
        startNewDutyDay();
      }
      current.hotelLayover = trimmedLine;
      current.rawLines.push(trimmedLine);
      continue;
    }

    if (current) {
      current.summary = current.summary
        ? `${current.summary} | ${trimmedLine}`
        : trimmedLine;
    }
  }

  if (current) {
    finalizeCurrentDay();
  }

  return duties.map((day) => ({
    rawLines: day.rawLines,
    legs: day.legs,
    reportLine: day.reportLine,
    reportTime: day.reportTime,
    calendarDay: day.calendarDay,
    releaseLine: day.releaseLine,
    releaseTime: day.releaseTime,
    hotelLayover: day.hotelLayover,
    summary: day.summary,
  }));
}

function parseSequence(block: string[]): SequenceRecord {
  const [header, ...rest] = block;
  const headerInfo = parseSequenceHeader(header);
  const totalsLine = rest.find((line) => /\bTTL\b/.test(line));
  const totals = totalsLine ? parseTotals(totalsLine) : undefined;
  const dutyLines = totalsLine ? rest.slice(0, rest.indexOf(totalsLine)) : rest;
  const dutyDays = parseDutyDays(dutyLines);

  return {
    sequenceNumber: headerInfo.sequenceNumber,
    instancesInMonth: headerInfo.instancesInMonth,
    positions: headerInfo.positions,
    totals,
    dutyDays,
    rawLines: block,
  };
}

function extractBaseFleetFromFile(fileName: string): { base: string; fleet: string } {
  const name = fileName.replace(/\.pdf$/i, "");
  const match = /(\w{3})_(\d{3})/i.exec(name);
  if (match) {
    return { base: match[1].toUpperCase(), fleet: match[2] };
  }
  return { base: "UNKNOWN", fleet: "UNKNOWN" };
}

function extractMonthFromToken(token: string): string | undefined {
  const upper = token.toUpperCase();
  return MONTHS.includes(upper) ? upper : undefined;
}

function extractMonthYear(pages: string[], fileName: string): { month: string; year: number } {
  for (const page of pages) {
    const calendarMatch = /FDP\s+CALENDAR\s+([0-9\/\-–]+)/i.exec(page);
    if (calendarMatch) {
      const monthPart = calendarMatch[1].split(/[\/-–]/)[0];
      const monthNumber = monthPart.slice(0, 2);
      const monthIndex = Number(monthNumber) - 1;
      if (monthIndex >= 0 && monthIndex < MONTHS.length) {
        const yearMatch = /([0-9]{4})/.exec(page);
        if (yearMatch) {
          return { month: MONTHS[monthIndex], year: Number(yearMatch[1]) };
        }
      }
    }

    const longMonthMatch = /(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+([0-9]{4})/i.exec(
      page,
    );
    if (longMonthMatch) {
      return {
        month: longMonthMatch[1].substring(0, 3).toUpperCase(),
        year: Number(longMonthMatch[2]),
      };
    }

    const compactMatch = /([0-9]{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)([0-9]{4})/i.exec(page);
    if (compactMatch) {
      const month = extractMonthFromToken(compactMatch[2]);
      if (month) {
        return { month, year: Number(compactMatch[3]) };
      }
    }

    const shortMonthMatch = /(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+([0-9]{4})/i.exec(page);
    if (shortMonthMatch) {
      return { month: shortMonthMatch[1].toUpperCase(), year: Number(shortMonthMatch[2]) };
    }
  }

  const fileMatch = /(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)([0-9]{4})/i.exec(fileName);
  if (fileMatch) {
    return { month: fileMatch[1].toUpperCase(), year: Number(fileMatch[2]) };
  }

  return { month: "UNKNOWN", year: new Date().getFullYear() };
}

function hoursToClock(value?: number | string): string | null {
  if (value === undefined || value === null) return null;
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return null;
  const totalMinutes = Math.round(numeric * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function parseClock(value?: string): string | null {
  if (!value) return null;
  const clean = value.split("/")[0];
  if (/^[0-9]{3,4}$/.test(clean)) {
    const padded = clean.padStart(4, "0");
    return `${padded.slice(0, 2)}:${padded.slice(2)}`;
  }
  return null;
}

function parseCalendarDay(day: string | undefined, monthIndex: number, year: number): string | null {
  if (!day) return null;
  const match = /(\d{1,2})\/(\d{1,2})/.exec(day);
  if (match) {
    const calendarDay = Number(match[2]);
    const fallbackDay = Number(match[1]);
    const dayNumber = Number.isFinite(calendarDay) ? calendarDay : fallbackDay;
    if (Number.isFinite(dayNumber)) {
      const date = new Date(Date.UTC(year, monthIndex, dayNumber));
      return date.toISOString().slice(0, 10);
    }
  }
  return null;
}

function parseLayover(raw: string | undefined): UploadedDuty["layover"] {
  if (!raw) return null;
  const tokens = raw.split(/\s+/).filter(Boolean);
  const station = tokens.shift() || null;
  const remaining = tokens.join(" ") || null;
  const restMatch = /(\d{1,2}\.\d{2})/.exec(raw);
  const groundRest = restMatch ? hoursToClock(restMatch[1]) : null;
  return {
    station: station ? station.toUpperCase() : null,
    hotel_name: remaining,
    hotel_phone: null,
    transport_name: null,
    transport_phone: null,
    ground_rest: groundRest,
  };
}

function toUploadedSequence(
  record: SequenceRecord,
  monthIndex: number,
  year: number,
  displayRange: { start: string; end: string },
): UploadedSequence {
  const calendarDates = new Set<string>();
  for (const duty of record.dutyDays) {
    const iso = parseCalendarDay(duty.calendarDay, monthIndex, year);
    if (iso) calendarDates.add(iso);
  }

  const position = record.positions
    ? Object.keys(record.positions)
        .sort()
        .join(" ")
    : "Unknown";

  const notes = record.dutyDays
    .map((d) => d.summary)
    .filter(Boolean)
    .join(" | ") || null;

  return {
    sequence_number: Number(record.sequenceNumber) || Number(record.sequenceNumber.replace(/\D+/g, "")) || 0,
    position,
    length_days: record.dutyDays.length,
    spanish_operation: false,
    notes,
    calendar: {
      start_dates: Array.from(calendarDates),
      display_range_start: displayRange.start,
      display_range_end: displayRange.end,
    },
    totals: {
      block_time: hoursToClock(record.totals?.blockHours),
      credit_time: hoursToClock(record.totals?.credit),
      tafb: hoursToClock(record.totals?.dutyHours),
    },
    duties: record.dutyDays.map((duty, idx) => ({
      duty_index: idx + 1,
      report_local: parseClock(duty.reportTime),
      release_local: parseClock(duty.releaseTime),
      legs: duty.legs.map((leg, legIdx) => ({
        leg_index: legIdx + 1,
        equip_code: leg.equipment ?? null,
        flight_number: leg.flightNumber ?? null,
        dep_station: leg.departureStation ?? null,
        arr_station: leg.arrivalStation ?? null,
        dep_local: parseClock(leg.departureTime),
        arr_local: parseClock(leg.arrivalTime),
        block_time: hoursToClock(leg.blockTime),
        ground_time: null,
        meal: leg.meal ?? null,
      })),
      layover: parseLayover(duty.hotelLayover),
    })),
  };
}

function buildDisplayRange(monthIndex: number, year: number) {
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const start = new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, monthIndex, daysInMonth)).toISOString().slice(0, 10);
  return { start, end };
}

export async function parseBidPdf(buffer: Buffer, fileName: string): Promise<UploadedBidPacket> {
  const pdfParse = await loadPdfParse();
  const pdf = await pdfParse(buffer);
  const rawText = pdf.text || "";
  const pages = splitIntoPages(rawText);

  const { base, fleet } = extractBaseFleetFromFile(fileName);
  const { month, year } = extractMonthYear(pages, fileName);
  const monthIndex = Math.max(0, MONTHS.indexOf(month));
  const displayRange = buildDisplayRange(monthIndex, year);

  const sequences: SequenceRecord[] = [];
  for (const page of pages.length ? pages : [rawText]) {
    const blocks = splitSequences(page);
    for (const block of blocks) {
      sequences.push(parseSequence(block));
    }
  }

  const uploadSequences = sequences.map((sequence) =>
    toUploadedSequence(sequence, monthIndex, year, displayRange),
  );

  return {
    metadata: {
      base,
      fleet,
      month,
      year,
      bid_period_start: displayRange.start,
      bid_period_end: displayRange.end,
      source_document: fileName,
    },
    sequences: uploadSequences,
  };
}

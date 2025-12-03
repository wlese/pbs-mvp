import * as fs from 'fs';
import * as path from 'path';

interface SequenceTotals {
  credit?: number;
  dutyHours?: number;
  blockHours?: number;
}

interface SequencePositionCounts {
  [position: string]: number;
}

interface FlightLeg {
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
}

interface SequenceDutyDay {
  rawLines: string[];
  reportLine?: string;
  reportTime?: string;
  calendarDay?: string;
  releaseLine?: string;
  releaseTime?: string;
  hotelLayover?: string;
  summary?: string;
  legs: FlightLeg[];
}

interface SequenceRecord {
  sequenceNumber: string;
  instancesInMonth?: number;
  positions?: SequencePositionCounts;
  totals?: SequenceTotals;
  dutyDays: SequenceDutyDay[];
  rawLines: string[];
}

interface BidPacketJson {
  base: string;
  fleet: string;
  bidMonth: string;
  sequences: SequenceRecord[];
}

function splitIntoPages(rawText: string): string[] {
  const normalized = rawText.replace(/\r\n/g, '\n');
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
  const sequenceNumber = tokens[1] || tokens[0].replace(/[^0-9]/g, '');
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

  return { sequenceNumber, instancesInMonth, positions: Object.keys(positions).length ? positions : undefined };
}

function parseTotals(line: string): SequenceTotals | undefined {
  const totals: SequenceTotals = {};
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
  const match = /RPT\s+([0-9]{3,4}\/[0-9]{3,4})/.exec(line);
  return { reportLine: line, reportTime: match ? match[1] : undefined };
}

function parseRelease(line: string): { releaseLine: string; releaseTime?: string } {
  const match = /RLS\s+([0-9]{3,4}\/[0-9]{3,4})/.exec(line);
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
    leg.remarks = tokens.slice(idx).join(' ');
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
      } else if (current.reportLine) {
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
      current.summary = current.summary ? `${current.summary} | ${trimmedLine}` : trimmedLine;
    }
  }

  if (current) {
    finalizeCurrentDay();
  }

  return duties;
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

function extractBaseFleetFromFile(filePath: string): { base: string; fleet: string } {
  const fileName = path.basename(filePath, path.extname(filePath));
  const match = /(\w{3})_(\d{3})/i.exec(fileName);
  if (match) {
    return { base: match[1].toUpperCase(), fleet: match[2] };
  }
  return { base: 'UNKNOWN', fleet: 'UNKNOWN' };
}

function extractMonthFromToken(token: string): string | undefined {
  const months: Record<string, string> = {
    JAN: 'JAN',
    FEB: 'FEB',
    MAR: 'MAR',
    APR: 'APR',
    MAY: 'MAY',
    JUN: 'JUN',
    JUL: 'JUL',
    AUG: 'AUG',
    SEP: 'SEP',
    OCT: 'OCT',
    NOV: 'NOV',
    DEC: 'DEC',
  };
  const upper = token.toUpperCase();
  return months[upper];
}

function extractBidMonth(pages: string[], filePath: string): string {
  for (const page of pages) {
    const calendarMatch = /FDP\s+CALENDAR\s+([0-9/\-–]+)/i.exec(page);
    if (calendarMatch) {
      const monthPart = calendarMatch[1].split(/[\/-–]/)[0];
      const monthNumber = monthPart.slice(0, 2);
      const monthIndex = Number(monthNumber) - 1;
      const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      if (monthIndex >= 0 && monthIndex < months.length) {
        const yearMatch = /([0-9]{4})/.exec(page);
        if (yearMatch) {
          return `${months[monthIndex]} ${yearMatch[1]}`;
        }
      }
    }

    const longMonthMatch = /(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+([0-9]{4})/i.exec(page);
    if (longMonthMatch) {
      return `${longMonthMatch[1].substring(0, 3).toUpperCase()} ${longMonthMatch[2]}`;
    }

    const compactMatch = /([0-9]{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)([0-9]{4})/i.exec(page);
    if (compactMatch) {
      const month = extractMonthFromToken(compactMatch[2]);
      if (month) {
        return `${month} ${compactMatch[3]}`;
      }
    }

    const shortMonthMatch = /(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+([0-9]{4})/i.exec(page);
    if (shortMonthMatch) {
      return `${shortMonthMatch[1].toUpperCase()} ${shortMonthMatch[2]}`;
    }
  }

  const fileName = path.basename(filePath, path.extname(filePath));
  const fileMatch = /(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)([0-9]{4})/i.exec(fileName);
  if (fileMatch) {
    return `${fileMatch[1].toUpperCase()} ${fileMatch[2]}`;
  }

  return 'UNKNOWN';
}

function saveBidPacketJson(outputPath: string, data: BidPacketJson): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  // eslint-disable-next-line no-console
  console.log(`Saved bid packet JSON to ${outputPath}`);
}

function main(): void {
  const textPath = path.resolve('data/raw/BOS_737_DEC2025.txt');
  const rawText = fs.readFileSync(textPath, 'utf8');
  const pages = splitIntoPages(rawText);

  const { base, fleet } = extractBaseFleetFromFile(textPath);
  const bidMonth = extractBidMonth(pages, textPath);

  const sequences: SequenceRecord[] = [];
  for (const page of pages.length ? pages : [rawText]) {
    const blocks = splitSequences(page);
    for (const block of blocks) {
      sequences.push(parseSequence(block));
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    'Sample duty day grouping:',
    JSON.stringify(
      sequences.slice(0, 3).map((sequence) => ({
        sequence: sequence.sequenceNumber,
        dutyDays: sequence.dutyDays.map((day) => ({
          report: day.reportTime || day.reportLine,
          legs: day.legs.length,
          release: day.releaseTime || day.releaseLine,
          hotel: day.hotelLayover,
        })),
      })),
      null,
      2,
    ),
  );

  const output: BidPacketJson = {
    base,
    fleet,
    bidMonth,
    sequences,
  };

  const outputPath = path.resolve('data/json/BOS_737_DEC2025.json');
  saveBidPacketJson(outputPath, output);
  // eslint-disable-next-line no-console
  console.log(`Parsed ${sequences.length} sequences.`);
}

main();

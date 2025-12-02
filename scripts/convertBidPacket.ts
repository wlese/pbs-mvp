import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

interface SequenceTotals {
  credit?: number;
  dutyHours?: number;
  blockHours?: number;
}

interface SequencePositionCounts {
  [position: string]: number;
}

interface SequenceDutyDay {
  raw: string;
  legs: string[];
  hotelLayover?: string;
  calendarDay?: string;
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

function decodePdfString(value: string): string {
  // Handle escaped parentheses and backslashes
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === '(' || next === ')' || next === '\\') {
        result += next;
        i += 1;
      } else if (/\d/.test(next)) {
        const octalMatch = value.slice(i + 1, i + 4).match(/[0-7]{1,3}/);
        if (octalMatch) {
          result += String.fromCharCode(parseInt(octalMatch[0], 8));
          i += octalMatch[0].length;
        }
      }
    } else {
      result += char;
    }
  }
  // Collapse kerning gaps like "S E Q" -> "SEQ"
  result = result.replace(/\b([A-Z0-9])\s(?=[A-Z0-9]\b)/g, '$1');
  result = result.replace(/\s{2,}/g, ' ');
  return result.trim();
}

function extractTextFromContent(content: string): string[] {
  const snippets: string[] = [];
  const textRegex = /\(([^()]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(content))) {
    const decoded = decodePdfString(match[1]);
    if (decoded) {
      snippets.push(decoded);
    }
  }
  return snippets;
}

function buildPageTextsFromStreams(pdfPath: string): string[] {
  const buffer = fs.readFileSync(pdfPath);
  const pdfString = buffer.toString('latin1');
  const streamRegex = /stream\r?\n/g;
  const pageTexts: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(pdfString))) {
    const streamStart = match.index + match[0].length;
    const endStreamIndex = pdfString.indexOf('endstream', streamStart);
    if (endStreamIndex === -1) break;

    const rawStream = buffer.subarray(streamStart, endStreamIndex);
    let decoded = rawStream;
    try {
      decoded = zlib.inflateSync(rawStream);
    } catch (error) {
      // Leave undecoded when inflate fails
    }

    const snippets = extractTextFromContent(decoded.toString('latin1'));
    if (snippets.length) {
      pageTexts.push(snippets.join('\n'));
    }

    streamRegex.lastIndex = endStreamIndex + 'endstream'.length;
  }

  return pageTexts;
}

function extractBaseFleetFromFile(filePath: string): { base: string; fleet: string } {
  const fileName = path.basename(filePath, path.extname(filePath));
  const match = /(\w{3})_(\d{3})/i.exec(fileName);
  if (match) {
    return { base: match[1].toUpperCase(), fleet: match[2] };
  }
  return { base: 'UNKNOWN', fleet: 'UNKNOWN' };
}

function extractBidMonth(pages: string[]): string {
  for (const page of pages) {
    const calendarMatch = /FDP\s+CALENDAR\s+([0-9/\-–]+)/i.exec(page);
    if (calendarMatch) {
      return calendarMatch[1].replace(/–/g, '-');
    }
    const monthYearMatch = /(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+([0-9]{4})/i.exec(
      page,
    );
    if (monthYearMatch) {
      return `${monthYearMatch[1].substring(0, 3).toUpperCase()} ${monthYearMatch[2]}`;
    }
  }
  return 'UNKNOWN';
}

function splitSequences(pageText: string): string[][] {
  const lines = pageText
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
  const tokens = headerLine.split(/\s+/).filter(Boolean);
  const sequenceNumber = tokens[1]?.replace(/\D/g, '') || tokens[0].replace(/\D/g, '');

  const instancesIndex = tokens.findIndex((token) => token.toUpperCase() === 'OPS');
  const instancesInMonth = instancesIndex > 1 && /^\d+$/.test(tokens[instancesIndex - 1])
    ? Number(tokens[instancesIndex - 1])
    : undefined;

  const positions: SequencePositionCounts = {};
  const posnIndex = tokens.findIndex((token) => token.toUpperCase() === 'POSN');
  if (posnIndex !== -1) {
    for (let i = posnIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i].toUpperCase();
      if (/^(CA|FO|RL|AP|RS|PQ|DQ)$/.test(token)) {
        positions[token] = (positions[token] || 0) + 1;
        continue;
      }
      break;
    }
  }

  return { sequenceNumber, instancesInMonth, positions: Object.keys(positions).length ? positions : undefined };
}

function parseTotals(line: string): SequenceTotals | undefined {
  const numberParts = line
    .replace(/TTL/i, '')
    .trim()
    .split(/\s+/)
    .filter((value) => /^-?\d+(?:\.\d+)?$/.test(value))
    .map(Number);

  if (!numberParts.length) return undefined;

  const [credit, blockHours, dutyHours] = numberParts;

  const totals: SequenceTotals = {
    credit,
    blockHours,
    dutyHours,
  };

  return totals;
}

function parseDutyDays(lines: string[]): SequenceDutyDay[] {
  const duties: SequenceDutyDay[] = [];
  for (const line of lines) {
    const legs = line.split(/\s{2,}/).filter(Boolean);
    const hotelMatch = /([A-Z]{3})\s+HOTEL/i.exec(line);
    const calendarMatch = /^\s*(\d{1,2})\b/.exec(line);
    duties.push({
      raw: line,
      legs,
      hotelLayover: hotelMatch ? hotelMatch[1].toUpperCase() : undefined,
      calendarDay: calendarMatch ? calendarMatch[1] : undefined,
    });
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

function saveBidPacketJson(outputPath: string, data: BidPacketJson): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  // eslint-disable-next-line no-console
  console.log(`Saved bid packet JSON to ${outputPath}`);
}

function main(): void {
  const pdfPath = path.resolve('data/raw/BOS_737_DEC2025.pdf');
  const pages = buildPageTextsFromStreams(pdfPath);

  const { base, fleet } = extractBaseFleetFromFile(pdfPath);
  const bidMonth = extractBidMonth(pages);

  const sequences: SequenceRecord[] = [];
  for (const page of pages) {
    const blocks = splitSequences(page);
    for (const block of blocks) {
      sequences.push(parseSequence(block));
    }
  }

  const output: BidPacketJson = {
    base,
    fleet,
    bidMonth,
    sequences,
  };

  const outputPath = path.resolve('data/json/BOS_737_DEC2025.json');
  saveBidPacketJson(outputPath, output);
}

main();

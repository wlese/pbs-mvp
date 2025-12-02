"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
function readPdfObjects(pdfPath) {
    const buffer = fs.readFileSync(pdfPath);
    const pdfString = buffer.toString('latin1');
    const objectRegex = /(\d+)\s+0\s+obj([\s\S]*?)endobj/g;
    const objects = [];
    let match;
    while ((match = objectRegex.exec(pdfString))) {
        const objectNumber = Number(match[1]);
        const body = match[2];
        const streamMatch = /stream\r?\n/.exec(body);
        let stream;
        if (streamMatch) {
            const streamStartInBody = streamMatch.index + streamMatch[0].length;
            const endStreamIndex = body.indexOf('endstream', streamStartInBody);
            if (endStreamIndex !== -1) {
                const streamStart = match.index + streamStartInBody;
                const streamEnd = match.index + endStreamIndex;
                stream = buffer.subarray(streamStart, streamEnd);
            }
        }
        const filterMatches = [];
        const filterRegex = /\/Filter\s*(\[(.*?)\]|\/(\w+))/g;
        let filterMatch;
        while ((filterMatch = filterRegex.exec(body))) {
            if (filterMatch[2]) {
                filterMatches.push(...filterMatch[2]
                    .split(/\s+/)
                    .map((value) => value.replace(/\//g, ''))
                    .filter(Boolean));
            }
            if (filterMatch[3]) {
                filterMatches.push(filterMatch[3]);
            }
        }
        const isPage = /\/Type\s*\/Page\b/.test(body);
        const contentRefs = [];
        const contentsMatch = /\/Contents\s*(\[[^\]]+\]|\d+\s+0\s+R)/.exec(body);
        if (contentsMatch) {
            const refBlock = contentsMatch[1];
            const refs = [...refBlock.matchAll(/(\d+)\s+0\s+R/g)].map((ref) => Number(ref[1]));
            contentRefs.push(...refs);
        }
        objects.push({
            objectNumber,
            body,
            stream,
            filters: filterMatches,
            isPage,
            contentRefs,
        });
    }
    return objects;
}
function decodeStream(stream, filters) {
    if (!stream)
        return '';
    let data = stream;
    if (filters.some((filter) => /FlateDecode/i.test(filter))) {
        try {
            data = zlib.inflateSync(stream);
        }
        catch (error) {
            // leave as-is when inflate fails
        }
    }
    return data.toString('latin1');
}
function decodePdfString(value) {
    // Handle escaped parentheses and backslashes
    let result = '';
    for (let i = 0; i < value.length; i += 1) {
        const char = value[i];
        if (char === '\\' && i + 1 < value.length) {
            const next = value[i + 1];
            if (next === '(' || next === ')' || next === '\\') {
                result += next;
                i += 1;
            }
            else if (/\d/.test(next)) {
                const octalMatch = value.slice(i + 1, i + 4).match(/[0-7]{1,3}/);
                if (octalMatch) {
                    result += String.fromCharCode(parseInt(octalMatch[0], 8));
                    i += octalMatch[0].length;
                }
            }
        }
        else {
            result += char;
        }
    }
    // Collapse kerning gaps like "S E Q" -> "SEQ"
    result = result.replace(/\b([A-Z0-9])\s(?=[A-Z0-9]\b)/g, '$1');
    result = result.replace(/\s{2,}/g, ' ');
    return result.trim();
}
function extractTextFromContent(content) {
    const snippets = [];
    const textRegex = /\(([^()]*)\)/g;
    let match;
    while ((match = textRegex.exec(content))) {
        const decoded = decodePdfString(match[1]);
        if (decoded) {
            snippets.push(decoded);
        }
    }
    return snippets;
}
function buildPageTexts(objects) {
    const pageTexts = [];
    const pageObjects = objects.filter((obj) => obj.isPage);
    for (const page of pageObjects) {
        const pageSnippets = [];
        for (const ref of page.contentRefs) {
            const contentObject = objects.find((obj) => obj.objectNumber === ref);
            if (!contentObject)
                continue;
            const decoded = decodeStream(contentObject.stream, contentObject.filters);
            const snippets = extractTextFromContent(decoded);
            pageSnippets.push(...snippets);
        }
        pageTexts.push(pageSnippets.join('\n'));
    }
    return pageTexts;
}
function extractBaseFleetFromFile(filePath) {
    const fileName = path.basename(filePath, path.extname(filePath));
    const match = /(\w{3})_(\d{3})/i.exec(fileName);
    if (match) {
        return { base: match[1].toUpperCase(), fleet: match[2] };
    }
    return { base: 'UNKNOWN', fleet: 'UNKNOWN' };
}
function extractBidMonth(pages) {
    for (const page of pages) {
        const calendarMatch = /FDP\s+CALENDAR\s+([0-9/\-–]+)/i.exec(page);
        if (calendarMatch) {
            return calendarMatch[1].replace(/–/g, '-');
        }
        const monthYearMatch = /(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+([0-9]{4})/i.exec(page);
        if (monthYearMatch) {
            return `${monthYearMatch[1].substring(0, 3).toUpperCase()} ${monthYearMatch[2]}`;
        }
    }
    return 'UNKNOWN';
}
function splitSequences(pageText) {
    const lines = pageText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const sequences = [];
    let current = [];
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
function parseSequenceHeader(headerLine) {
    const tokens = headerLine.split(/\s+/);
    const sequenceNumber = tokens[1] || tokens[0].replace(/[^0-9]/g, '');
    let instancesInMonth;
    const positions = {};
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
function parseTotals(line) {
    const totals = {};
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
function parseDutyDays(lines) {
    const duties = [];
    for (const line of lines) {
        const legs = line.split(/\s{2,}/).filter(Boolean);
        const hotelMatch = /HLT\s*([A-Z]{3})/i.exec(line);
        const calendarMatch = /\b([0-9]{1,2})\b/.exec(line);
        duties.push({
            raw: line,
            legs,
            hotelLayover: hotelMatch ? hotelMatch[1].toUpperCase() : undefined,
            calendarDay: calendarMatch ? calendarMatch[1] : undefined,
        });
    }
    return duties;
}
function parseSequence(block) {
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
function saveBidPacketJson(outputPath, data) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
    // eslint-disable-next-line no-console
    console.log(`Saved bid packet JSON to ${outputPath}`);
}
function main() {
    const pdfPath = path.resolve('data/raw/BOS_737_DEC2025.pdf');
    const objects = readPdfObjects(pdfPath);
    const pages = buildPageTexts(objects);
    const { base, fleet } = extractBaseFleetFromFile(pdfPath);
    const bidMonth = extractBidMonth(pages);
    const sequences = [];
    for (const page of pages) {
        const blocks = splitSequences(page);
        for (const block of blocks) {
            sequences.push(parseSequence(block));
        }
    }
    const output = {
        base,
        fleet,
        bidMonth,
        sequences,
    };
    const outputPath = path.resolve('data/json/BOS_737_DEC2025.json');
    saveBidPacketJson(outputPath, output);
}
main();

export type BidMonthDefinition = {
  name: string;
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
};

export type BidMonthRange = {
  start: Date;
  end: Date;
};

export const BID_MONTH_DEFINITIONS: BidMonthDefinition[] = [
  { name: "January", startMonth: 0, startDay: 1, endMonth: 0, endDay: 30 },
  { name: "February", startMonth: 0, startDay: 31, endMonth: 2, endDay: 1 },
  { name: "March", startMonth: 2, startDay: 2, endMonth: 2, endDay: 31 },
  { name: "April", startMonth: 3, startDay: 1, endMonth: 4, endDay: 1 },
  { name: "May", startMonth: 4, startDay: 2, endMonth: 5, endDay: 1 },
  { name: "June", startMonth: 5, startDay: 2, endMonth: 6, endDay: 1 },
  { name: "July", startMonth: 6, startDay: 2, endMonth: 6, endDay: 31 },
  { name: "August", startMonth: 7, startDay: 1, endMonth: 7, endDay: 31 },
  { name: "September", startMonth: 8, startDay: 1, endMonth: 8, endDay: 30 },
  { name: "October", startMonth: 9, startDay: 1, endMonth: 9, endDay: 31 },
  { name: "November", startMonth: 10, startDay: 1, endMonth: 11, endDay: 1 },
  { name: "December", startMonth: 11, startDay: 2, endMonth: 11, endDay: 31 },
];

export const BID_MONTHS = BID_MONTH_DEFINITIONS.map((definition) => definition.name);

function normalizeMonthIndex(month: number) {
  if (!Number.isInteger(month) || month < 0) return 0;
  if (month >= BID_MONTH_DEFINITIONS.length) return BID_MONTH_DEFINITIONS.length - 1;
  return month;
}

export function getBidMonthRange(year: number, month: number): BidMonthRange {
  const safeMonth = normalizeMonthIndex(month);
  const definition = BID_MONTH_DEFINITIONS[safeMonth];

  const start = new Date(year, definition.startMonth, definition.startDay);
  const end = new Date(year, definition.endMonth, definition.endDay);

  return { start, end };
}

export function getBidMonthLength(year: number, month: number): number {
  const { start, end } = getBidMonthRange(year, month);
  const millis = end.getTime() - start.getTime();
  return Math.round(millis / (1000 * 60 * 60 * 24)) + 1;
}

export function getBidMonthDisplayRange(year: number, month: number) {
  const safeMonth = normalizeMonthIndex(month);
  const definition = BID_MONTH_DEFINITIONS[safeMonth];

  const start = new Date(Date.UTC(year, definition.startMonth, definition.startDay))
    .toISOString()
    .slice(0, 10);
  const end = new Date(Date.UTC(year, definition.endMonth, definition.endDay))
    .toISOString()
    .slice(0, 10);

  return { start, end };
}

export function buildBidMonthDates(
  year: number,
  month: number,
  dayCount?: number,
): Date[] {
  const range = getBidMonthRange(year, month);
  const totalDays = dayCount ?? getBidMonthLength(year, month);

  return Array.from({ length: totalDays }, (_, idx) => {
    const d = new Date(range.start);
    d.setDate(range.start.getDate() + idx);
    return d;
  });
}

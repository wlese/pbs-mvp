// app/page.tsx
"use client";

import { useEffect, useState } from "react";
import pairingsData from "@/data/pairings.json";

// ---------- Types ----------

type DaysOffProperty = {
  name: string;
  layers: number[];
};

type DayOffRequest = {
  date: string; // YYYY-MM-DD
  strength: "must" | "prefer";
  layers: number[];
};

type PairingRequest = {
  tripNumber: string;
  date: string; // start date YYYY-MM-DD
  layers: number[];
  comment?: string;
};

type LineProperty = {
  name: string;
  layers: number[];
};

type ReserveProperty = {
  layer: number; // 1–10
  isReserveLayer?: boolean;
  avoidLineholder?: boolean;
  reserveLinePreference?: "S" | "L" | "S-L" | "L-S";
  workBlockMin?: number | null;
  workBlockMax?: number | null;
  preferFlyThroughDays?: string[];
  waiveReserveBlockOf4DaysOff?: boolean;
  allowSingleReserveDayOff?: boolean;
  waiveFirstDayDFPRequirement?: boolean;
  notes?: string;
};

type PbsResult = {
  summary?: string;
  daysOffProperties?: DaysOffProperty[];
  dayOffRequests?: DayOffRequest[];
  pairingRequests?: PairingRequest[];
  lineProperties?: LineProperty[];
  reserveProperties?: ReserveProperty[];
  notes?: string;
  raw?: string;
};

type StatusPreference =
  | "lineholder_only"
  | "reserve_only"
  | "lineholder_preferred"
  | "reserve_preferred";

type CalendarDay = {
  date: Date;
  day: number;
  inMonth: boolean;
};

type TabType =
  | "Dashboard"
  | "Days Off"
  | "Pairing"
  | "Line"
  | "Reserve"
  | "Layer"
  | "Award"
  | "Standing Bid";

// ---------- Constants ----------

const DOMICILES = [
  "BOS",
  "CLT",
  "DCA",
  "DFW",
  "LAX",
  "LGA",
  "MIA",
  "ORD",
  "PHL",
  "PHX",
];

const SEATS = ["CA", "FO"];
const EQUIPMENT = ["737", "320", "787", "777"];

const TABS: TabType[] = [
  "Dashboard",
  "Days Off",
  "Pairing",
  "Line",
  "Reserve",
  "Layer",
  "Award",
  "Standing Bid",
];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// ---------- Helpers for pairings.json ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Build a map from tripNumber → list of dates (YYYY-MM-DD) that trip covers.
 * This tries to be forgiving about how the JSON is structured.
 */
function buildPairingSpanMap(raw: unknown): Map<string, string[]> {
  try {
    const arr: unknown[] = Array.isArray(raw)
      ? raw
      : isRecord(raw) && Array.isArray(raw.pairings)
      ? raw.pairings
      : isRecord(raw) && Array.isArray(raw.trips)
      ? raw.trips
      : [];

    const map = new Map<string, string[]>();

    for (const t of arr) {
      if (!isRecord(t)) continue;
      const obj = t;

      const idCandidate =
        obj["tripNumber"] ??
        obj["TripNumber"] ??
        obj["TRIP_NUMBER"] ??
        obj["pairingNumber"] ??
        obj["PairingNumber"] ??
        obj["PAIRING_NUMBER"] ??
        obj["pairingId"] ??
        obj["PairingID"] ??
        obj["id"] ??
        obj["ID"] ??
        obj["trip"] ??
        obj["Trip"] ??
        obj["pairing"] ??
        obj["Pairing"];

      if (!idCandidate) continue;
      const tripId = String(idCandidate).trim();
      if (!tripId) continue;

      let dates: string[] = [];

      // 1) Explicit dates array
      if (Array.isArray(obj["dates"])) {
        dates = (obj["dates"] as unknown[])
          .map((d) => (typeof d === "string" ? d : null))
          .filter((d): d is string => Boolean(d));
      }

      // 2) Duty periods with date / depDate
      if (!dates.length && Array.isArray(obj["dutyPeriods"])) {
        for (const dp of obj["dutyPeriods"] as unknown[]) {
          if (!isRecord(dp)) continue;
          const dutyDate = dp["date"];
          const depDate = dp["depDate"];
          const d =
            typeof dutyDate === "string"
              ? dutyDate
              : typeof depDate === "string"
              ? depDate
              : null;
          if (d) dates.push(d);
        }
      }

      // 3) Start date + length in days
      if (!dates.length && typeof obj["startDate"] === "string") {
        const start = obj["startDate"] as string;
        const lenRaw =
          obj["lengthDays"] ??
          obj["length"] ??
          obj["tripLength"] ??
          obj["DAYS"] ??
          obj["BLK_DAYS"] ??
          1;
        const days = Number(lenRaw) || 1;
        const startDate = new Date(start);
        if (!isNaN(startDate.getTime())) {
          for (let i = 0; i < days; i++) {
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i);
            dates.push(d.toISOString().slice(0, 10));
          }
        }
      }

      // 4) Single date field
      if (!dates.length && typeof obj["date"] === "string") {
        dates = [obj["date"] as string];
      }

      dates = Array.from(new Set(dates)); // dedupe

      if (dates.length) {
        map.set(tripId, dates);
      }
    }

    return map;
  } catch {
    // If anything weird happens, just return empty map and we fall back to single-day display.
    return new Map();
  }
}

const PAIRING_SPANS = buildPairingSpanMap(pairingsData);

// ---------- Other helpers ----------

function layersToString(layers?: number[]) {
  if (!layers || !layers.length) return "—";
  return [...layers].sort((a, b) => a - b).join(", ");
}

function parseSafeDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d;
}

function inferYearMonth(result: PbsResult | null): {
  year: number;
  month: number; // 0–11
  label: string;
} {
  const dateSources: string[] = [];
  if (result?.dayOffRequests) {
    for (const d of result.dayOffRequests) dateSources.push(d.date);
  }
  if (result?.pairingRequests) {
    for (const p of result.pairingRequests) dateSources.push(p.date);
  }

  for (const s of dateSources) {
    const d = parseSafeDate(s);
    if (d) {
      const year = d.getFullYear();
      const month = d.getMonth();
      return { year, month, label: `${MONTHS[month]} ${year}` };
    }
  }

  // Fallback to December 2025 (like your screenshots)
  return { year: 2025, month: 11, label: "December 2025" };
}

function buildCalendar(year: number, month: number): CalendarDay[] {
  const firstOfMonth = new Date(year, month, 1);
  const startDay = firstOfMonth.getDay(); // 0=Sun
  const days: CalendarDay[] = [];

  const firstCellDate = new Date(year, month, 1 - startDay);
  for (let i = 0; i < 42; i++) {
    const d = new Date(firstCellDate);
    d.setDate(firstCellDate.getDate() + i);
    days.push({
      date: d,
      day: d.getDate(),
      inMonth: d.getMonth() === month,
    });
  }

  return days;
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

// ---------- Component ----------

export default function Home() {
  // Inputs
  const [domicile, setDomicile] = useState("BOS");
  const [seat, setSeat] = useState<"CA" | "FO">("FO");
  const [equipment, setEquipment] = useState("737");
  const [seniority, setSeniority] = useState(50);
  const [mustOffDays, setMustOffDays] = useState("");
  const [wantOffDays, setWantOffDays] = useState("");
  const [idealSchedule, setIdealSchedule] = useState("");
  const [statusPreference, setStatusPreference] =
    useState<StatusPreference>("lineholder_preferred");

  // UI / result state
  const [activeTab, setActiveTab] = useState<TabType>("Dashboard");
  const [currentLayer, setCurrentLayer] = useState<number>(1);
  const [result, setResult] = useState<PbsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (loading) {
      setProgress(5);
      const interval = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 95) return prev;
          const next = prev + Math.random() * 12;
          return next >= 95 ? 95 : next;
        });
      }, 300);

      return () => clearInterval(interval);
    }

    if (!loading && progress > 0) {
      setProgress(100);
      const timeout = setTimeout(() => setProgress(0), 400);
      return () => clearTimeout(timeout);
    }
  }, [loading, progress]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    if (!idealSchedule.trim()) {
      setLoading(false);
      setError("Please describe your ideal schedule.");
      return;
    }

    const combinedPreferences = `
DOMICILE: ${domicile}
SEAT: ${seat}
EQUIPMENT: ${equipment}
APPROX BIDDING SENIORITY: ${seniority}%

DAYS YOU MUST HAVE OFF:
${mustOffDays || "None specified"}

DAYS YOU WANT OFF:
${wantOffDays || "None specified"}

IDEAL SCHEDULE:
${idealSchedule || "None specified"}
`.trim();

    try {
      const res = await fetch("/api/pbs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferences: combinedPreferences,
          statusPreference,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Unknown error from server");
      }

      setResult(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  function handleCopy(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  // Calendar based on result
  const { year, month, label: monthLabel } = inferYearMonth(result);
  const calendarDays = buildCalendar(year, month);

  const isReserveLayer = Boolean(
    result?.reserveProperties?.some((r) => r.layer === currentLayer)
  );

  // Build a map of date → pairingRequests (using real span from pairings.json)
  const pairingDayMap = new Map<string, PairingRequest[]>();
  if (result?.pairingRequests) {
    for (const pr of result.pairingRequests) {
      const spanDates =
        PAIRING_SPANS.get(pr.tripNumber) ?? [pr.date]; // fall back to 1-day if not found
      for (const d of spanDates) {
        const key = d;
        if (!pairingDayMap.has(key)) pairingDayMap.set(key, []);
        pairingDayMap.get(key)!.push(pr);
      }
    }
  }

  const activeReserve =
    result?.reserveProperties?.find((r) => r.layer === currentLayer) ?? null;
  const fallbackReserve = result?.reserveProperties?.[0] ?? null;
  const reserveForPanel = activeReserve || fallbackReserve;

  return (
    <main className="min-h-screen bg-[#f2f2f2] text-slate-900 flex justify-center p-4">
      {loading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl border border-[#c7dff8] p-6 w-[340px] text-center space-y-3">
            <div className="text-xs font-semibold text-[#4a90e2] uppercase tracking-[0.2em]">
              Generating PBS Bid...
            </div>
            <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#4a90e2] transition-all duration-300"
                style={{ width: `${Math.max(progress, 8)}%` }}
              />
            </div>
            <div className="text-[13px] text-[#4a4a4a]">
              Please wait while we build a single bid type per layer (lineholder
              pairings or reserve request).
            </div>
          </div>
        </div>
      )}

      <div className="w-full max-w-6xl bg-[#f7f7f7] rounded-3xl shadow-lg border border-slate-300 overflow-hidden">
        {/* Top PBS-style tab bar */}
        <div className="flex items-center bg-[#d0d0d0] text-[15px] font-semibold">
          {TABS.map((tab) => {
            const selected = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                className={`px-4 py-3 border-r border-[#b8b8b8] ${
                  selected
                    ? "bg-white text-[#4a90e2] rounded-t-3xl border-t-2 border-x-2 border-[#c7dff8]"
                    : "bg-[#d0d0d0] text-[#555]"
                }`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            );
          })}
          <div className="flex-1 bg-[#d0d0d0]" />
        </div>

        {(loading || progress > 0) && (
          <div className="px-4 pt-3">
            <div className="flex items-center gap-3 bg-white border border-slate-300 rounded-xl shadow-sm p-3">
              <div className="flex-1">
                <div className="text-xs font-semibold text-[#4a90e2] uppercase tracking-[0.14em]">
                  Generating PBS Bid
                </div>
                <div className="h-2 mt-2 bg-slate-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#4a90e2] transition-all duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
              <div className="text-sm font-bold text-[#4a4a4a] w-14 text-right">
                {Math.round(progress)}%
              </div>
            </div>
          </div>
        )}

        {/* Main layout */}
        <div className="flex flex-col lg:flex-row gap-4 p-4">
          {/* LEFT: month strip + calendar */}
          <div className="w-full lg:w-[58%] space-y-3">
            {/* Month strip */}
            <div className="bg-[#e6e6e6] rounded-2xl p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-lg font-semibold text-[#555]">
                  {monthLabel}
                </div>
                <div className="text-xs tracking-[0.18em] text-[#999] uppercase">
                  2 &nbsp; · · &nbsp; 8 &nbsp; · · &nbsp; 15 &nbsp; · · &nbsp;
                  22 &nbsp; · · &nbsp; 29 · 31
                </div>
              </div>
              {/* Layer strip 1–10 */}
              <div className="mt-2 space-y-1 text-xs">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((layer) => (
                  <div key={layer} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCurrentLayer(layer)}
                      className={`w-10 h-5 flex items-center justify-center rounded-full text-[11px] font-semibold ${
                        layer === currentLayer
                          ? "bg-[#4a90e2] text-white"
                          : "bg-[#bdbdbd] text-[#444]"
                      }`}
                    >
                      {layer}
                    </button>
                    <div className="flex-1 grid grid-cols-24 gap-[1px]">
                      {Array.from({ length: 24 }).map((_, idx) => (
                        <div
                          key={idx}
                          className="h-3 rounded-sm bg-[#dcdcdc]"
                        />
                      ))}
                    </div>
                    {layer >= 8 && (
                      <span className="text-[10px] text-[#777] uppercase ml-1">
                        Reserve
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Big calendar for current layer */}
            <div className="bg-[#4a4a4a] rounded-2xl pt-3 pb-4 px-3">
              <div className="flex items-center justify-between mb-2 px-1">
                <div className="text-sm font-semibold text-white">
                  LAYER {currentLayer}
                  {activeReserve ? (
                    <span className="ml-2 text-[11px] uppercase text-[#b2f5ea]">
                      Reserve Layer
                    </span>
                  ) : (
                    <span className="ml-2 text-[11px] uppercase text-[#d2e6ff]">
                      Lineholder Layer
                    </span>
                  )}
                </div>
                {result?.summary && (
                  <span className="text-[10px] text-[#ccc] max-w-[60%] text-right line-clamp-2">
                    {result.summary}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-7 text-[11px] text-[#dbdbdb] mb-1">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                  (d) => (
                    <div key={d} className="text-center pb-1">
                      {d}
                    </div>
                  )
                )}
              </div>

              <div className="grid grid-cols-7 gap-[2px]">
                {calendarDays.map((d, idx) => {
                  const iso = dayKey(d.date);

                  const offReqs =
                    result?.dayOffRequests
                      ?.filter(
                        (r) =>
                          r.date === iso && r.layers?.includes(currentLayer)
                      )
                      .filter((r) =>
                        isReserveLayer ? true : r.strength === "must"
                      ) ?? [];

                  // Pull all pairings whose span includes this iso, then filter by layer
                  const allDayPairings = pairingDayMap.get(iso) ?? [];
                  const pairings = isReserveLayer
                    ? []
                    : allDayPairings.filter((p) =>
                        p.layers?.includes(currentLayer)
                      );

                  const hasMust = offReqs.some((o) => o.strength === "must");
                  const hasPrefer = offReqs.some(
                    (o) => o.strength === "prefer"
                  );

                  const offLabel = isReserveLayer
                    ? hasMust
                      ? "OFF\nMust"
                      : hasPrefer
                      ? "OFF\nPrefer"
                      : ""
                    : hasMust
                    ? "OFF"
                    : "";

                  const visibleTrips = pairings.slice(0, 2);
                  const extraTrips =
                    pairings.length > 2 ? pairings.length - 2 : 0;

                  return (
                    <div
                      key={idx}
                      className={`min-h-[62px] rounded-md border border-[#5b5b5b] flex flex-col justify-between p-[3px] ${
                        d.inMonth
                          ? "bg-[#f7f4ef]"
                          : "bg-[#c7c7c7] text-[#888]"
                      }`}
                    >
                      <div className="flex justify-between items-start text-[10px]">
                        <span className="font-semibold">{d.day}</span>
                      </div>

                      {offLabel && (
                        <div className="mt-1 text-[9px] leading-[10px] whitespace-pre rounded-sm bg-[#1fb8c6] text-white font-semibold px-1 py-[1px]">
                          {offLabel}
                        </div>
                      )}

                      <div className="mt-1 space-y-[1px]">
                        {visibleTrips.map((p) => (
                          <div
                            key={p.tripNumber}
                            className="text-[9px] rounded-sm bg-[#83c341] text-[#224000] font-semibold text-center px-1 py-[1px]"
                          >
                            {p.tripNumber}
                          </div>
                        ))}
                        {extraTrips > 0 && (
                          <div className="text-[9px] text-[#555] text-center">
                            +{extraTrips} more
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* RIGHT: tab content / info panels */}
          <div className="w-full lg:w-[42%] space-y-3">
            {/* Mini "bid package" header */}
            <div className="bg-white rounded-2xl border border-[#dedede] p-3 text-[11px] tracking-[0.16em] text-[#999] uppercase">
              <div className="font-semibold mb-2">
                Bid Package Information (Local)
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px] normal-case tracking-normal text-[#333]">
                <div className="space-y-1">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[#999]">
                    Lineholders
                  </div>
                  <div className="text-lg font-semibold">—</div>
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[#999]">
                    4 Part Bid Status
                  </div>
                  <div className="text-sm font-semibold">
                    {domicile}/{seat}/{equipment}/DOM
                  </div>
                </div>
              </div>
            </div>

            {/* Tab content panel */}
            <div className="bg-white rounded-2xl border border-[#dedede] p-3 text-sm">
              {activeTab === "Dashboard" && (
                <div className="space-y-3">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-[#999]">
                    Bid Input (Dashboard)
                  </div>
                  <form onSubmit={handleSubmit} className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <label className="block text-[10px] uppercase tracking-[0.16em] text-[#999] mb-1">
                          Domicile
                        </label>
                        <select
                          className="w-full border border-[#cfcfcf] rounded-md px-2 py-1 bg-[#fdfdfd]"
                          value={domicile}
                          onChange={(e) => setDomicile(e.target.value)}
                        >
                          {DOMICILES.map((d) => (
                            <option key={d}>{d}</option>
                          ))}
                        </select>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] uppercase tracking-[0.16em] text-[#999] mb-1">
                            Seat
                          </label>
                          <select
                            className="w-full border border-[#cfcfcf] rounded-md px-2 py-1 bg-[#fdfdfd]"
                            value={seat}
                            onChange={(e) =>
                              setSeat(e.target.value as "CA" | "FO")
                            }
                          >
                            {SEATS.map((s) => (
                              <option key={s}>{s}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] uppercase tracking-[0.16em] text-[#999] mb-1">
                            Equip
                          </label>
                          <select
                            className="w-full border border-[#cfcfcf] rounded-md px-2 py-1 bg-[#fdfdfd]"
                            value={equipment}
                            onChange={(e) => setEquipment(e.target.value)}
                          >
                            {EQUIPMENT.map((eq) => (
                              <option key={eq}>{eq}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-1 text-xs">
                      <label className="block text-[10px] uppercase tracking-[0.16em] text-[#999] mb-1">
                        Bidding Seniority (approx)
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={1}
                          max={100}
                          value={seniority}
                          onChange={(e) =>
                            setSeniority(Number(e.target.value))
                          }
                          className="flex-1"
                        />
                        <span className="w-10 text-right text-[11px]">
                          {seniority}%
                        </span>
                      </div>
                    </div>

                    <div className="space-y-1 text-xs">
                      <label className="block text-[10px] uppercase tracking-[0.16em] text-[#999] mb-1">
                        Bid Type Preference
                      </label>
                      <select
                        className="w-full border border-[#cfcfcf] rounded-md px-2 py-1 bg-[#fdfdfd]"
                        value={statusPreference}
                        onChange={(e) =>
                          setStatusPreference(
                            e.target.value as StatusPreference
                          )
                        }
                      >
                        <option value="lineholder_only">
                          Lineholder ONLY
                        </option>
                        <option value="reserve_only">Reserve ONLY</option>
                        <option value="lineholder_preferred">
                          Lineholder preferred (reserve backup)
                        </option>
                        <option value="reserve_preferred">
                          Reserve preferred (lineholder backup)
                        </option>
                      </select>
                    </div>

                    <div className="space-y-2 text-xs">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] uppercase tracking-[0.16em] text-[#999] mb-1">
                            Days you MUST have off
                          </label>
                          <textarea
                            className="w-full h-16 border border-[#cfcfcf] rounded-md px-2 py-1 bg-[#fdfdfd]"
                            value={mustOffDays}
                            onChange={(e) =>
                              setMustOffDays(e.target.value)
                            }
                            placeholder="e.g. Dec 24–26; Jan 3"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] uppercase tracking-[0.16em] text-[#999] mb-1">
                            Days you WANT off
                          </label>
                          <textarea
                            className="w-full h-16 border border-[#cfcfcf] rounded-md px-2 py-1 bg-[#fdfdfd]"
                            value={wantOffDays}
                            onChange={(e) =>
                              setWantOffDays(e.target.value)
                            }
                            placeholder="e.g. most Saturdays; Dec 30–31"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-[0.16em] text-[#999] mb-1">
                          Describe your ideal schedule
                        </label>
                        <textarea
                          className="w-full h-16 border border-[#cfcfcf] rounded-md px-2 py-1 bg-[#fdfdfd]"
                          value={idealSchedule}
                          onChange={(e) =>
                            setIdealSchedule(e.target.value)
                          }
                          placeholder="e.g. Prefer 2–3 day trips, avoid redeyes, MIA layovers, etc."
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={loading || !idealSchedule.trim()}
                      className="w-full mt-1 rounded-md bg-[#4a90e2] text-white text-xs font-semibold py-2 disabled:bg-[#b0c8ec]"
                    >
                      {loading
                        ? "Generating PBS Plan..."
                        : "Generate PBS Plan"}
                    </button>
                  </form>

                  {error && (
                    <div className="text-xs text-red-500 bg-red-50 border border-red-200 rounded-md px-2 py-1">
                      Error: {error}
                    </div>
                  )}
                </div>
              )}

              {activeTab === "Days Off" && (
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-[#999]">
                    Days Off Properties
                  </div>
                  {!result?.daysOffProperties?.length &&
                    !result?.dayOffRequests?.length && (
                      <p className="text-xs text-[#777]">
                        No specific days off recommendations yet. Generate a
                        plan from the Dashboard.
                      </p>
                    )}

                  {result?.daysOffProperties?.length ? (
                    <div className="space-y-1 text-xs">
                      {result.daysOffProperties.map((p, idx) => (
                        <div
                          key={idx}
                          className="border border-[#ddd] rounded-md px-2 py-1 bg-[#fafafa]"
                        >
                          <div className="font-semibold">{p.name}</div>
                          <div className="text-[11px] text-[#555]">
                            Layers: {layersToString(p.layers)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {result?.dayOffRequests?.length ? (
                    <div className="mt-2 border-t border-[#eee] pt-2 space-y-1 text-xs">
                      <div className="font-semibold">
                        Specific OFF / PREFER dates
                      </div>
                      {result.dayOffRequests.map((d, idx) => (
                        <div
                          key={idx}
                          className="border border-[#ddd] rounded-md px-2 py-1 bg-[#fdfdfd]"
                        >
                          <div className="flex justify-between items-center">
                            <span className="font-mono text-[11px]">
                              {d.date}
                            </span>
                            <span className="text-[10px] uppercase rounded-full px-2 py-[1px] bg-[#e0e0e0]">
                              {d.strength === "must"
                                ? "Must Off"
                                : "Prefer Off"}
                            </span>
                          </div>
                          <div className="text-[11px] text-[#555]">
                            Layers: {layersToString(d.layers)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {result?.daysOffProperties?.length ? (
                    <button
                      type="button"
                      className="mt-2 text-[11px] text-[#4a90e2] underline"
                      onClick={() =>
                        handleCopy(
                          JSON.stringify(
                            {
                              daysOffProperties:
                                result.daysOffProperties,
                              dayOffRequests: result.dayOffRequests ?? [],
                            },
                            null,
                            2
                          )
                        )
                      }
                    >
                      Copy Days Off JSON
                    </button>
                  ) : null}
                </div>
              )}

              {activeTab === "Pairing" && (
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-[#999]">
                    Pairing ID on Date
                  </div>
                  {!result?.pairingRequests?.length && (
                    <p className="text-xs text-[#777]">
                      No specific pairings yet. Generate a plan from the
                      Dashboard.
                    </p>
                  )}
                  {result?.pairingRequests?.length ? (
                    <div className="space-y-1 text-xs">
                      {result.pairingRequests.map((p, idx) => (
                        <div
                          key={idx}
                          className="border border-[#ddd] rounded-md px-2 py-1 bg-[#fafafa]"
                        >
                          <div className="flex justify-between items-center">
                            <span className="font-mono text-[11px]">
                              {p.tripNumber} on {p.date}
                            </span>
                            <span className="text-[11px] text-[#555]">
                              Layers: {layersToString(p.layers)}
                            </span>
                          </div>
                          {p.comment && (
                            <div className="text-[11px] text-[#666] mt-1">
                              {p.comment}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {result?.pairingRequests?.length ? (
                    <button
                      type="button"
                      className="mt-2 text-[11px] text-[#4a90e2] underline"
                      onClick={() =>
                        handleCopy(
                          JSON.stringify(
                            { pairingRequests: result.pairingRequests },
                            null,
                            2
                          )
                        )
                      }
                    >
                      Copy Pairing JSON
                    </button>
                  ) : null}
                </div>
              )}

              {activeTab === "Line" && (
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-[#999]">
                    Line / Pairing Properties
                  </div>
                  {!result?.lineProperties?.length && (
                    <p className="text-xs text-[#777]">
                      No line properties suggested yet.
                    </p>
                  )}
                  {result?.lineProperties?.length ? (
                    <div className="space-y-1 text-xs">
                      {result.lineProperties.map((p, idx) => (
                        <div
                          key={idx}
                          className="border border-[#ddd] rounded-md px-2 py-1 bg-[#fafafa]"
                        >
                          <div className="font-semibold">{p.name}</div>
                          <div className="text-[11px] text-[#555]">
                            Layers: {layersToString(p.layers)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {result?.lineProperties?.length ? (
                    <button
                      type="button"
                      className="mt-2 text-[11px] text-[#4a90e2] underline"
                      onClick={() =>
                        handleCopy(
                          JSON.stringify(
                            { lineProperties: result.lineProperties },
                            null,
                            2
                          )
                        )
                      }
                    >
                      Copy Line JSON
                    </button>
                  ) : null}
                </div>
              )}

              {activeTab === "Reserve" && (
                <div className="space-y-3 text-xs">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-[#999]">
                    Reserve
                  </div>

                  {!result?.reserveProperties?.length && (
                    <p className="text-xs text-[#777]">
                      No reserve layers suggested yet. If you are bidding
                      reserve, generate a plan from the Dashboard with a
                      reserve-focused status preference.
                    </p>
                  )}

                  {result?.reserveProperties?.length ? (
                    <>
                      {/* PBS-style blue reserve panel */}
                      <div className="bg-[#e5f2ff] border border-[#c4dcff] rounded-xl p-3 text-xs text-slate-900">
                        <div className="flex items-center justify-between mb-2">
                          <div className="space-y-1">
                            <div className="text-[10px] uppercase tracking-[0.18em] text-[#6c8bbf]">
                              Reserve
                            </div>
                            {reserveForPanel ? (
                              <div className="text-[12px] text-[#344152]">
                                The current layer (Layer{" "}
                                <span className="font-semibold">
                                  {currentLayer}
                                </span>
                                ) is{" "}
                                {activeReserve ? (
                                  <>
                                    a{" "}
                                    <span className="font-semibold">
                                      reserve layer
                                    </span>
                                    .
                                  </>
                                ) : (
                                  <>
                                    currently{" "}
                                    <span className="font-semibold">
                                      not set
                                    </span>{" "}
                                    as reserve. Showing reserve settings from
                                    Layer{" "}
                                    <span className="font-semibold">
                                      {reserveForPanel.layer}
                                    </span>
                                    .
                                  </>
                                )}
                              </div>
                            ) : (
                              <div className="text-[12px] text-[#344152]">
                                No layers have reserve properties yet.
                              </div>
                            )}
                          </div>
                          <button className="px-3 py-1.5 rounded-full border border-[#c4dcff] text-[11px] font-medium bg-white hover:bg-[#f5f8ff]">
                            Change to {activeReserve ? "Regular" : "Reserve"}{" "}
                            Layer
                          </button>
                        </div>

                        <div className="bg-white border border-[#d4e4ff] text-[#2f3f54] rounded-md px-3 py-2 mb-2">
                          Reserve layers cannot include specific pairings. For
                          a given layer, bid either reserve with OFF-day
                          preferences or lineholder pairings—not both.
                        </div>

                        {reserveForPanel && (
                          <div className="space-y-2">
                            {/* Avoid Lineholder */}
                            <div className="flex items-center justify-between gap-3 bg-[#f2f6ff] rounded-md px-3 py-2">
                              <div className="text-[11px] font-medium text-[#344152]">
                                Avoid Lineholder
                              </div>
                              <div className="flex items-center justify-center w-6">
                                <div
                                  className={`w-4 h-4 rounded border ${
                                    reserveForPanel.avoidLineholder
                                      ? "bg-[#4a90e2] border-[#4a90e2]"
                                      : "border-[#9fb3d1] bg-white"
                                  }`}
                                />
                              </div>
                            </div>

                            {/* Reserve Line Preference */}
                            <div className="flex items-center justify-between gap-3 bg-[#f2f6ff] rounded-md px-3 py-2">
                              <div className="text-[11px] font-medium text-[#344152]">
                                Reserve Line Preference
                              </div>
                              <select
                                className="h-7 text-[11px] border border-[#c4d0e8] rounded-md px-2 bg-white"
                                value={
                                  reserveForPanel.reserveLinePreference || "S"
                                }
                                disabled
                              >
                                <option value="S">S</option>
                                <option value="L">L</option>
                                <option value="S-L">S-L</option>
                                <option value="L-S">L-S</option>
                              </select>
                            </div>

                            {/* Reserve Work Block Size */}
                            <div className="flex items-center justify-between gap-3 bg-[#f2f6ff] rounded-md px-3 py-2">
                              <div className="text-[11px] font-medium text-[#344152]">
                                Reserve Work Block Size
                              </div>
                              <div className="flex items-center gap-1 text-[11px] text-[#4a4a4a]">
                                <span className="text-[#7b8595]">Min</span>
                                <input
                                  className="w-10 h-6 text-[11px] border border-[#c4d0e8] rounded-md px-1 bg-white text-center"
                                  value={
                                    reserveForPanel.workBlockMin ?? ""
                                  }
                                  readOnly
                                />
                                <span className="ml-2 text-[#7b8595]">
                                  Max
                                </span>
                                <input
                                  className="w-10 h-6 text-[11px] border border-[#c4d0e8] rounded-md px-1 bg-white text-center"
                                  value={
                                    reserveForPanel.workBlockMax ?? ""
                                  }
                                  readOnly
                                />
                              </div>
                            </div>

                            {/* Prefer Fly Through Days */}
                            <div className="flex items-center justify-between gap-3 bg-[#f2f6ff] rounded-md px-3 py-2">
                              <div className="text-[11px] font-medium text-[#344152]">
                                Prefer Fly Through Days
                              </div>
                              <select
                                className="h-7 text-[11px] border border-[#c4d0e8] rounded-md px-2 bg-white"
                                value={
                                  reserveForPanel.preferFlyThroughDays &&
                                  reserveForPanel.preferFlyThroughDays[0]
                                    ? reserveForPanel
                                        .preferFlyThroughDays[0]
                                    : ""
                                }
                                disabled
                              >
                                <option value="">(none)</option>
                                <option value="weekdays">Weekdays</option>
                                <option value="weekends">Weekends</option>
                              </select>
                            </div>

                            {/* Waive Reserve Block of 4 Days Off */}
                            <div className="flex items-center justify-between gap-3 bg-[#f2f6ff] rounded-md px-3 py-2">
                              <div className="text-[11px] font-medium text-[#344152]">
                                Waive Reserve Block of 4 Days Off
                              </div>
                              <div className="flex items-center justify-center w-6">
                                <div
                                  className={`w-4 h-4 rounded border ${
                                    reserveForPanel.waiveReserveBlockOf4DaysOff
                                      ? "bg-[#4a90e2] border-[#4a90e2]"
                                      : "border-[#9fb3d1] bg-white"
                                  }`}
                                />
                              </div>
                            </div>

                            {/* Allow Single Reserve Day Off */}
                            <div className="flex items-center justify-between gap-3 bg-[#f2f6ff] rounded-md px-3 py-2">
                              <div className="text-[11px] font-medium text-[#344152]">
                                Allow Single Reserve Day Off
                              </div>
                              <div className="flex items-center justify-center w-6">
                                <div
                                  className={`w-4 h-4 rounded border ${
                                    reserveForPanel.allowSingleReserveDayOff
                                      ? "bg-[#4a90e2] border-[#4a90e2]"
                                      : "border-[#9fb3d1] bg-white"
                                  }`}
                                />
                              </div>
                            </div>

                            {/* Waive First Day of Month DFP Requirement */}
                            <div className="flex items-center justify-between gap-3 bg-[#f2f6ff] rounded-md px-3 py-2">
                              <div className="text-[11px] font-medium text-[#344152]">
                                Waive First Day of Month DFP Requirement
                              </div>
                              <div className="flex items-center justify-center w-6">
                                <div
                                  className={`w-4 h-4 rounded border ${
                                    reserveForPanel.waiveFirstDayDFPRequirement
                                      ? "bg-[#4a90e2] border-[#4a90e2]"
                                      : "border-[#9fb3d1] bg-white"
                                  }`}
                                />
                              </div>
                            </div>

                            {reserveForPanel.notes && (
                              <div className="mt-2 text-[11px] text-[#4a4a4a] bg-[#f7f9ff] rounded-md px-3 py-2">
                                {reserveForPanel.notes}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        className="mt-2 text-[11px] text-[#4a90e2] underline"
                        onClick={() =>
                          handleCopy(
                            JSON.stringify(
                              { reserveProperties: result.reserveProperties },
                              null,
                              2
                            )
                          )
                        }
                      >
                        Copy Reserve JSON
                      </button>
                    </>
                  ) : null}
                </div>
              )}

              {activeTab === "Layer" && (
                <div className="space-y-2 text-xs">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-[#999]">
                    Layer Overview
                  </div>
                  <p className="text-[#555]">
                    Use the blue buttons on the left mini calendar to select
                    LAYER 1–10. This panel mirrors how your AI plan is
                    structured by layer (line vs reserve, OFF dates, and
                    specific pairings).
                  </p>
                  <p className="text-[#444] bg-[#eef2ff] border border-[#d5defe] rounded-md px-3 py-2">
                    Each layer is either a <strong>lineholder bid</strong>
                    (specific pairings and layer-specific OFF days) or a
                    <strong> reserve bid</strong> (reserve request plus OFF day
                    preferences). A single layer cannot mix both.
                  </p>
                  <p className="text-[#777]">
                    Current layer: <strong>{currentLayer}</strong>{" "}
                    {activeReserve ? "(Reserve layer)" : "(Line layer)"}
                  </p>
                </div>
              )}

              {(activeTab === "Award" ||
                activeTab === "Standing Bid") && (
                <div className="space-y-2 text-xs">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-[#999]">
                    {activeTab} (Mockup)
                  </div>
                  <p className="text-[#555]">
                    In the real PBS system this tab would show your award or
                    standing bid. Here it’s reserved for future features
                    (e.g., predicted award quality or reusable standing
                    preference sets).
                  </p>
                </div>
              )}
            </div>

            {result?.notes && (
              <div className="bg-white rounded-2xl border border-[#dedede] p-3 text-xs">
                <div className="text-[11px] uppercase tracking-[0.16em] text-[#999] mb-1">
                  Additional Notes
                </div>
                <p className="text-[#444] whitespace-pre-wrap">
                  {result.notes}
                </p>
              </div>
            )}

            {result?.raw && (
              <div className="bg-yellow-50 border border-yellow-300 rounded-2xl p-3 text-[11px] text-yellow-900 whitespace-pre-wrap">
                Raw model output (fallback):
                {"\n"}
                {result.raw}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

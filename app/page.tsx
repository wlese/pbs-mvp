// app/page.tsx
"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
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

type FlightLeg = {
  raw?: string;
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
  raw?: string;
  rawLines?: string[];
  reportLine?: string;
  reportTime?: string;
  legs?: FlightLeg[];
  releaseLine?: string;
  releaseTime?: string;
  hotelLayover?: string;
  calendarDay?: string;
  summary?: string;
};

type PairingSequence = {
  sequenceNumber?: string;
  instancesInMonth?: number;
  totals?: { credit?: number };
  dutyDays?: SequenceDutyDay[];
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

const PROGRESS_STEPS = [
  "Loading PBS rules…",
  "Analyzing your schedule preferences…",
  "Evaluating available pairings…",
  "Optimizing bid strategy…",
  "Finalizing recommended bid…",
];

const VALID_USERNAME = "test";
const VALID_PASSWORD = "test";

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

function buildCalendar(
  year: number,
  month: number,
  daysInMonthLimit?: number
): CalendarDay[] {
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
      inMonth:
        d.getMonth() === month &&
        (typeof daysInMonthLimit === "number"
          ? d.getDate() <= daysInMonthLimit
          : true),
    });
  }

  return days;
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function deriveBidMonthDays(year: number, month: number) {
  const naturalMonthLength = new Date(year, month + 1, 0).getDate();
  return Math.min(31, Math.max(30, naturalMonthLength));
}

// ---------- Component ----------

export default function Home() {
  // Authentication
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

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
  const [progressStage, setProgressStage] = useState<number>(-1);
  const [mounted, setMounted] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [viewMode, setViewMode] = useState<"user" | "admin">("user");
  const [pairingSequences, setPairingSequences] = useState<PairingSequence[]>([]);
  const [sequencesLoading, setSequencesLoading] = useState(false);
  const [sequencesError, setSequencesError] = useState<string | null>(null);
  const [debugSequences, setDebugSequences] = useState<PairingSequence[]>([]);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);

  const inferredYearMonth = inferYearMonth(result);
  const [adminYear, setAdminYear] = useState<number>(inferredYearMonth.year);
  const [adminMonth, setAdminMonth] = useState<number>(inferredYearMonth.month);
  const [adminDaysInMonth, setAdminDaysInMonth] = useState<number>(() =>
    deriveBidMonthDays(inferredYearMonth.year, inferredYearMonth.month)
  );
  const [adminTouched, setAdminTouched] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem("pbs-authenticated");
    if (stored === "true") {
      setIsAuthenticated(true);
    }
    setAuthChecked(true);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;

    setMounted(true);

    const existing = document.getElementById("pbs-overlay-root");
    if (existing) {
      setPortalRoot(existing);
      return;
    }

    const node = document.createElement("div");
    node.setAttribute("id", "pbs-overlay-root");
    document.body.appendChild(node);
    setPortalRoot(node);

    return () => {
      document.body.removeChild(node);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!loading) return;

    setProgressStage((prev) => (prev >= 0 ? prev : 0));

    const interval = setInterval(() => {
      setProgressStage((prev) =>
        Math.min(prev + 1, PROGRESS_STEPS.length - 1)
      );
    }, 1200);

    return () => clearInterval(interval);
  }, [loading]);

  useEffect(() => {
    if (loading) return;
    if (progressStage === -1) return;

    setProgressStage(PROGRESS_STEPS.length - 1);

    const timeout = setTimeout(() => setProgressStage(-1), 700);
    return () => clearTimeout(timeout);
  }, [loading, progressStage]);

  const overlayVisible = loading || progressStage >= 0;

  useEffect(() => {
    if (!mounted) return;

    const originalOverflow = document.body.style.overflow;

    if (overlayVisible) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = originalOverflow;
    }

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [overlayVisible, mounted]);

  useEffect(() => {
    const next = inferYearMonth(result);
    if (adminTouched) return;

    setAdminYear(next.year);
    setAdminMonth(next.month);
    setAdminDaysInMonth(deriveBidMonthDays(next.year, next.month));
  }, [result, adminTouched]);

  function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoginError(null);

    if (username.trim() === VALID_USERNAME && password === VALID_PASSWORD) {
      setIsAuthenticated(true);
      if (typeof window !== "undefined") {
        localStorage.setItem("pbs-authenticated", "true");
      }
    } else {
      setLoginError("Invalid username or password. Please use test/test.");
    }
  }

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

      const combinedPreferences = [
        `DOMICILE: ${domicile}`,
        `SEAT: ${seat}`,
        `EQUIPMENT: ${equipment}`,
        `APPROX BIDDING SENIORITY: ${seniority}%`,
        "",
        "DAYS YOU MUST HAVE OFF:",
        mustOffDays || "None specified",
        "",
        "DAYS YOU WANT OFF:",
        wantOffDays || "None specified",
        "",
        "IDEAL SCHEDULE:",
        idealSchedule || "None specified",
      ].join("\n");

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

  async function handleLoadSequences() {
    setSequencesLoading(true);
    setSequencesError(null);

    try {
      const res = await fetch("/api/sequences");
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "Failed to load sequences");
      }

      const rawSequences: unknown = Array.isArray(data?.sequences)
        ? data.sequences
        : Array.isArray(data)
        ? data
        : [];

      const normalized = (Array.isArray(rawSequences) ? rawSequences : [])
        .filter((item): item is PairingSequence => isRecord(item))
        .map((item) => ({ ...item }));

      setPairingSequences(normalized);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Something went wrong loading sequences";
      setSequencesError(message);
      setPairingSequences([]);
    } finally {
      setSequencesLoading(false);
    }
  }

  async function loadDebugTrips() {
    try {
      setDebugLoading(true);
      setDebugError(null);
      setDebugSequences([]);

      const res = await fetch("/api/sequences?minDays=1&maxDays=6", {
        cache: "no-store",
      });
      const data = await res.json();
      console.log("Debug API data:", data);
      setDebugSequences(data.sequences ?? []);
    } catch (err) {
      console.error(err);
      setDebugError("Failed to load sequences");
    } finally {
      setDebugLoading(false);
    }
  }

  function handleAdminMonthChange(value: number) {
    setAdminMonth(value);
    setAdminTouched(true);
  }

  function handleAdminYearChange(value: number) {
    setAdminYear(value);
    setAdminTouched(true);
  }

  function handleAdminDayCountChange(value: number) {
    setAdminDaysInMonth(value);
    setAdminTouched(true);
  }

  if (!authChecked) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#f4f7fb] text-[#4a4a4a]">
        <div className="text-sm font-medium">Loading...</div>
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-[#f7f9ff] to-[#e4edff] flex items-center justify-center px-4">
        <div className="bg-white border border-[#dce8ff] shadow-2xl rounded-3xl max-w-md w-full p-8 space-y-6">
          <div className="flex items-center gap-4">
            <Image
              src="/crew-bid-logo.svg"
              alt="Crew Bid logo"
              width={64}
              height={64}
              className="w-16 h-16 drop-shadow-md"
              priority
            />
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-[0.24em] text-[#4a90e2] font-semibold">
                PBS Bidding Tool
              </p>
              <h1 className="text-2xl font-bold text-[#23395b]">Log in to Crew Bid</h1>
              <p className="text-sm text-[#4a4a4a]">
                Enter your credentials to access the bidding workspace.
              </p>
            </div>
          </div>

          <form className="space-y-4" onSubmit={handleLogin}>
            <div className="space-y-1">
              <label className="block text-[11px] uppercase tracking-[0.16em] text-[#7487a6] font-semibold">
                Username
              </label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full border border-[#c7dff8] rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4a90e2] bg-[#f9fbff]"
                placeholder="Enter username"
              />
            </div>

            <div className="space-y-1">
              <label className="block text-[11px] uppercase tracking-[0.16em] text-[#7487a6] font-semibold">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-[#c7dff8] rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4a90e2] bg-[#f9fbff]"
                placeholder="Enter password"
              />
            </div>

            {loginError && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-[#4a90e2] text-white rounded-xl py-2.5 text-sm font-semibold shadow-md hover:bg-[#3c7bc4] transition-colors"
            >
              Sign In
            </button>
            <p className="text-xs text-[#4a4a4a] text-center">
              Use <span className="font-semibold">test</span> / <span className="font-semibold">test</span> to enter the PBS bidding tool.
            </p>
          </form>
        </div>
      </main>
    );
  }

  // Calendar based on admin selection (defaulted from inferred result)
  const displayYear = adminYear;
  const displayMonth = adminMonth;
  const monthLabel = `${MONTHS[displayMonth]} ${displayYear}`;
  const calendarDays = buildCalendar(displayYear, displayMonth, adminDaysInMonth);
  const dayCells = Array.from({ length: adminDaysInMonth }, (_, idx) => idx + 1);
  const dayGridStyle = {
    gridTemplateColumns: `repeat(${adminDaysInMonth}, minmax(0, 1fr))`,
  };

  const layerIsReserve = (layer: number) =>
    Boolean(result?.reserveProperties?.some((r) => r.layer === layer));

  const isReserveLayer = layerIsReserve(currentLayer);

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

  const hasOffRequest = (iso: string, layer: number) =>
    result?.dayOffRequests?.some(
      (r) => r.date === iso && r.layers?.includes(layer)
    ) ?? false;

  const hasPairingForLayer = (iso: string, layer: number) =>
    (pairingDayMap.get(iso) ?? []).some((p) => p.layers?.includes(layer));

  const activeReserve =
    result?.reserveProperties?.find((r) => r.layer === currentLayer) ?? null;
  const fallbackReserve = result?.reserveProperties?.[0] ?? null;
  const reserveForPanel = activeReserve || fallbackReserve;

  const renderProgressSteps = (variant: "overlay" | "inline") => (
    <ol
      className={
        variant === "overlay"
          ? "space-y-2 text-left"
          : "space-y-1 text-left text-sm"
      }
    >
      {PROGRESS_STEPS.map((step, idx) => {
        const reached =
          progressStage >= idx ||
          (!loading && progressStage === PROGRESS_STEPS.length - 1);
        const isCurrent = loading && progressStage === idx;

        return (
          <li key={step} className="flex items-center gap-3">
            <span
              className={`w-3 h-3 rounded-full ${
                reached ? "bg-[#4a90e2]" : "bg-slate-300"
              } ${isCurrent ? "animate-pulse" : ""}`}
            />
            <span
              className={
                reached
                  ? "text-[#23426d] font-semibold"
                  : "text-[#6b7280]"
              }
            >
              {step}
            </span>
          </li>
        );
      })}
    </ol>
  );

  const overlay =
    mounted && portalRoot && overlayVisible
      ? createPortal(
          <div
            role="alertdialog"
            aria-modal="true"
            aria-live="assertive"
            aria-busy="true"
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          >
            <div className="absolute inset-0" aria-hidden="true" />
            <div className="relative bg-white rounded-2xl shadow-2xl border border-[#c7dff8] p-6 w-[340px] text-center space-y-3">
              <div className="text-xs font-semibold text-[#4a90e2] uppercase tracking-[0.2em]">
                Generating PBS Bid...
              </div>
              <div className="text-[13px] text-[#4a4a4a]">
                We’re working through the steps below to prepare your bid.
              </div>
              <div className="pt-1">{renderProgressSteps("overlay")}</div>
            </div>
          </div>,
          portalRoot
        )
      : null;

  return (
    <>
      {overlay}

      <main className="min-h-screen bg-[#f2f2f2] text-slate-900 flex justify-center p-4">
        <div className="w-full max-w-6xl bg-[#f7f7f7] rounded-3xl shadow-lg border border-slate-300 overflow-hidden">
          <div className="flex items-center justify-between bg-white border-b border-slate-300 px-4 py-3">
            <div className="flex items-center gap-3">
              <Image
                src="/crew-bid-logo.svg"
                alt="Crew Bid logo"
                width={44}
                height={44}
                className="w-11 h-11"
                priority
              />
              <div className="leading-tight">
                <div className="text-[11px] uppercase tracking-[0.24em] text-[#4a90e2] font-semibold">
                  Crew Bid
                </div>
                <div className="text-sm font-semibold text-[#2f4058]">
                  PBS Bidding Tool
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[#6b7a90] font-semibold">
                Mode
              </div>
              <div className="flex items-center bg-[#e6ebf3] rounded-full p-1 shadow-inner">
                <button
                  type="button"
                  onClick={() => setViewMode("user")}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                    viewMode === "user"
                      ? "bg-white text-[#23426d] shadow"
                      : "text-[#4a4a4a]"
                  }`}
                >
                  User
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("admin")}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                    viewMode === "admin"
                      ? "bg-white text-[#23426d] shadow"
                      : "text-[#4a4a4a]"
                  }`}
                >
                  Admin
                </button>
              </div>
            </div>
          </div>

          {viewMode === "admin" ? (
            <div className="p-6 space-y-4">
              <div className="bg-white border border-[#dbe4f2] rounded-2xl p-4 space-y-3 shadow-sm">
                <div className="text-[11px] uppercase tracking-[0.2em] text-[#6b7a90] font-semibold">
                  Admin configuration
                </div>
                <p className="text-sm text-[#4a4a4a]">
                  Choose the bid month settings that will appear on the User view.
                  Changes save automatically.
                </p>

                <div className="grid md:grid-cols-3 gap-3 text-sm">
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-[0.16em] text-[#8a9ab5] font-semibold">
                      Month
                    </span>
                    <select
                      className="border border-[#c7dff8] rounded-lg px-3 py-2 bg-[#f9fbff]"
                      value={adminMonth}
                      onChange={(e) => handleAdminMonthChange(Number(e.target.value))}
                    >
                      {MONTHS.map((m, idx) => (
                        <option key={m} value={idx}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-[0.16em] text-[#8a9ab5] font-semibold">
                      Year
                    </span>
                    <input
                      type="number"
                      className="border border-[#c7dff8] rounded-lg px-3 py-2 bg-[#f9fbff]"
                      value={adminYear}
                      min={2020}
                      max={2100}
                      onChange={(e) => handleAdminYearChange(Number(e.target.value))}
                    />
                  </label>

                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-[0.16em] text-[#8a9ab5] font-semibold">
                      Bid month length
                    </span>
                    <div className="flex items-center gap-2 bg-[#eef3fb] border border-[#c7dff8] rounded-lg p-2">
                      {[30, 31].map((days) => (
                        <button
                          key={days}
                          type="button"
                          onClick={() => handleAdminDayCountChange(days)}
                          className={`flex-1 py-2 rounded-md text-sm font-semibold transition-colors ${
                            adminDaysInMonth === days
                              ? "bg-white text-[#1f3f6a] shadow"
                              : "text-[#4a4a4a]"
                          }`}
                        >
                          {days}-Day
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-[#eef3ff] border border-[#d1defa] rounded-xl px-3 py-2 text-sm text-[#2f3f58] flex items-center justify-between">
                  <div>
                    <div className="font-semibold">User view will show</div>
                    <div className="text-[13px] text-[#4a4a4a]">
                      {monthLabel} • {adminDaysInMonth}-day bid month
                    </div>
                  </div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-[#4a90e2] font-semibold">
                    Auto-synced
                  </div>
                </div>
              </div>

              <div className="bg-white border border-[#dbe4f2] rounded-2xl p-4 space-y-3 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-[0.2em] text-[#6b7a90] font-semibold">
                      Pairing data
                    </div>
                    <p className="text-sm text-[#4a4a4a]">
                      Load the latest BOS 737 pairings and review their duty day details.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleLoadSequences}
                    className="inline-flex items-center gap-2 rounded-md bg-[#4a90e2] px-3 py-1 text-white text-sm font-semibold shadow hover:bg-[#3a7bc6] disabled:opacity-60"
                    disabled={sequencesLoading}
                  >
                    Load 737 Pairings
                  </button>
                </div>

                {sequencesError && (
                  <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                    Error loading pairings: {sequencesError}
                  </div>
                )}

                {sequencesLoading && (
                  <div className="text-sm text-[#4a4a4a] bg-[#eef3ff] border border-[#d1defa] rounded-md px-3 py-2">
                    Loading BOS 737 pairings…
                  </div>
                )}

                {pairingSequences.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-[#6b7a90] font-semibold">
                      {pairingSequences.length} pairings loaded
                    </div>

                    <div className="max-h-80 overflow-y-auto space-y-3 pr-1">
                      {pairingSequences.map((seq, idx) => {
                        const sequenceNumber = seq.sequenceNumber ?? "Unknown";
                        const credit =
                          typeof seq.totals === "object" && seq.totals !== null
                            ? (seq.totals as { credit?: number }).credit
                            : undefined;
                        const instances = seq.instancesInMonth;
                        const dutyDays = Array.isArray(seq.dutyDays)
                          ? seq.dutyDays
                          : [];

                        return (
                          <div
                            key={`${sequenceNumber}-${idx}`}
                            className="border border-[#dbe4f2] rounded-xl bg-[#f9fbff] p-3 space-y-2 shadow-sm"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-sm font-semibold text-[#23426d]">
                                Pairing {sequenceNumber}
                              </div>
                              <div className="text-[11px] text-[#4a4a4a] text-right leading-4">
                                {instances ? <div>{instances}× in month</div> : null}
                                {credit ? <div className="font-semibold">{credit} credit</div> : null}
                              </div>
                            </div>

                            {dutyDays.length > 0 ? (
                              <ul className="space-y-1 text-xs text-[#2f4058]">
                                {dutyDays.map((day, dayIdx) => (
                                  <li
                                    key={`${sequenceNumber}-day-${dayIdx}`}
                                    className="rounded-md border border-[#d6e3f5] bg-white px-2 py-1"
                                  >
                                    <div className="font-semibold text-[#23426d]">Duty Day {dayIdx + 1}</div>
                                    {day.raw ? <div className="whitespace-pre-wrap">{day.raw}</div> : null}
                                    {Array.isArray(day.legs) && day.legs.length > 0 && (
                                      <ul className="mt-1 space-y-[2px] text-[11px] text-[#3d4c66]">
                                        {day.legs.map((leg, legIdx) => (
                                          <li key={`${sequenceNumber}-day-${dayIdx}-leg-${legIdx}`} className="flex gap-1">
                                            <span className="text-[10px] uppercase tracking-[0.1em] text-[#8a9ab5] font-semibold">
                                              Leg {legIdx + 1}:
                                            </span>
                                            <span className="break-words">{leg}</span>
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <div className="text-xs text-[#6b7280]">No duty day details available.</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <p className="text-xs text-[#6b7280]">
                Switch back to <strong>User</strong> mode to see the bidding workspace with these settings applied.
              </p>
            </div>
          ) : (
            <>
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

              {(loading || progressStage >= 0) && (
                <div className="px-4 pt-3">
                  <div className="flex items-center gap-3 bg-white border border-slate-300 rounded-xl shadow-sm p-3">
                    <div className="flex-1 space-y-2">
                      <div className="text-xs font-semibold text-[#4a90e2] uppercase tracking-[0.14em]">
                        Generating PBS Bid
                      </div>
                      {renderProgressSteps("inline")}
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
                    <div className="flex items-start gap-3 mb-2">
                      <div className="text-lg font-semibold text-[#555] min-w-[132px]">
                        {monthLabel}
                      </div>
                      <div className="flex-1">
                        <div
                          className="grid gap-[1px] text-[10px] tracking-[0.12em] text-[#777] uppercase"
                          style={dayGridStyle}
                        >
                          {dayCells.map((day) => (
                            <div key={day} className="text-center leading-[14px]">
                              {day}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    {/* Layer strip 1–10 */}
                    <div className="mt-2 space-y-1 text-xs">
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((layer) => {
                        const reserveRow = layerIsReserve(layer);
                        const isSelected = layer === currentLayer;

                        return (
                          <div
                            key={layer}
                            className={`flex items-center gap-2 rounded-xl px-2 py-1 border transition-shadow ${
                              isSelected
                                ? "border-[#4a90e2] bg-[#eef3ff] shadow-sm"
                                : "border-transparent bg-white"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => setCurrentLayer(layer)}
                              className={`w-9 h-5 flex items-center justify-center rounded-full text-[11px] font-semibold border ${
                                isSelected
                                  ? "bg-[#4a90e2] text-white border-[#4a90e2]"
                                  : "bg-[#d6d6d6] text-[#444] border-[#c5c5c5]"
                              }`}
                            >
                              {layer}
                            </button>
                            <div
                              className="flex-1 grid gap-[1px]"
                              style={dayGridStyle}
                            >
                              {dayCells.map((day) => {
                                const iso = dayKey(
                                  new Date(displayYear, displayMonth, day)
                                );
                                const offDay = hasOffRequest(iso, layer);
                                const pairingDay = hasPairingForLayer(iso, layer);

                                const baseCell = "h-3 rounded-sm border";
                                const colorClass = reserveRow
                                  ? "bg-[#cfcfcf] border-[#b5b5b5]"
                                  : pairingDay
                                  ? "bg-[#7fbf4d] border-[#6aa23f]"
                                  : offDay
                                  ? "bg-[#8ebcf7] border-[#4a90e2]"
                                  : "bg-[#dcdcdc] border-[#cfcfcf]";

                                return (
                                  <div
                                    key={day}
                                    className={`${baseCell} ${colorClass}`}
                                    aria-hidden
                                  />
                                );
                              })}
                            </div>
                            {reserveRow && (
                              <span className="text-[10px] font-semibold text-[#6b6b6b] uppercase px-2 py-[1px] bg-[#ededed] border border-[#c9c9c9] rounded-full">
                                Reserve
                              </span>
                            )}
                          </div>
                        );
                      })}
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
                  <p className="text-xs text-[#4a4a4a]">
                    Enter your bid preferences below. Pairing data management now lives in
                    the Admin tab.
                  </p>
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
          </>
        )}
        </div>
      </main>

      <section className="mt-8 border-t pt-4 text-sm">
        <h2 className="font-semibold mb-2">Debug: BOS 737 Trips</h2>
        <button
          type="button"
          onClick={loadDebugTrips}
          className="mb-2 px-3 py-1 rounded bg-blue-600 text-white"
        >
          Load BOS 737 Trips
        </button>

        {debugLoading && <p>Loading trips…</p>}
        {debugError && <p className="text-red-600">{debugError}</p>}
        {!debugLoading && !debugError && (
          <p>
            Loaded <strong>{debugSequences.length}</strong> sequence(s).
          </p>
        )}

        <ul className="mt-2 max-h-64 overflow-auto space-y-1">
          {debugSequences.map((seq) => (
            <li key={seq.sequenceNumber} className="border rounded px-2 py-1">
              SEQ {seq.sequenceNumber} — {seq.dutyDays?.length ?? 0} day(s)
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

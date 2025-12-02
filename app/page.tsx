"use client";

import { useState } from "react";

type Sequence = {
  sequenceNumber: number;
  dutyDays: any[];
};

export default function PBSpage() {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadTrips() {
    try {
      setLoading(true);
      setError(null);
      setSequences([]);

      const res = await fetch("/api/sequences?minDays=1&maxDays=6", {
        cache: "no-store",
      });

      const data = await res.json();
      console.log("API data:", data); // <-- you will see this in DevTools

      // data.sequences should be an array
      setSequences(data.sequences ?? []);
    } catch (err) {
      console.error(err);
      setError("Failed to load sequences.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="p-6 space-y-4">
      <button
        onClick={loadTrips}
        className="px-4 py-2 rounded bg-blue-600 text-white font-semibold"
      >
        Load BOS 737 Trips
      </button>

      {loading && <p className="text-sm text-slate-600">Loading trips…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {!loading && !error && (
        <p className="text-sm text-slate-700">
          Loaded <strong>{sequences.length}</strong> sequence(s)
          from BOS 737 bid packet.
        </p>
      )}

      <ul className="mt-2 space-y-1 text-sm">
        {sequences.map((seq) => (
          <li key={seq.sequenceNumber} className="border rounded px-2 py-1">
            SEQ {seq.sequenceNumber} — {seq.dutyDays?.length ?? 0} day(s)
          </li>
        ))}
      </ul>
    </main>
  );
}

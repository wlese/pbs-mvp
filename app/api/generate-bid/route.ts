// app/api/pbs/route.ts
import { NextResponse } from "next/server";
import { openai } from "@/lib/openai";

import pbsRules from "@/data/pbs_rules.json";
import rawPairings from "@/data/pairings.json";

function ensureApiKey() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is missing. Make sure it is set in your .env.local file."
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findFirstObjectArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    const objectValues = value.filter(isRecord);
    if (objectValues.length > 0) {
      return objectValues;
    }
  }

  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      const child = value[key];
      const found = findFirstObjectArray(child);
      if (Array.isArray(found) && found.length > 0) {
        return found;
      }
    }
  }

  return [];
}

function getAllPairings(): Record<string, unknown>[] {
  const data: unknown = rawPairings;
  const arr = findFirstObjectArray(data);
  return Array.isArray(arr) ? arr : [];
}

const ALL_PAIRINGS: Record<string, unknown>[] = getAllPairings();

function getPairingsForThisRequest() {
  return ALL_PAIRINGS.slice(0, 100);
}

function describeStatusPreference(code: string) {
  switch (code) {
    case "lineholder_only":
      return {
        label: "Lineholder ONLY",
        guidance:
          "Build layers that seek only lineholder flying and avoid reserve lines entirely. Do not create reserve layers.",
      };
    case "reserve_only":
      return {
        label: "Reserve ONLY",
        guidance:
          "Build layers that seek only reserve assignments and avoid lineholder flying. Use Reserve tab logic in all layers.",
      };
    case "lineholder_preferred":
      return {
        label: "Lineholder preferred, reserve as backup",
        guidance:
          "Use top layers for lineholder-focused bidding (regular layers), and use some lower layers as reserve layers as a backup strategy.",
      };
    case "reserve_preferred":
      return {
        label: "Reserve preferred, lineholder as backup",
        guidance:
          "Use top layers as reserve layers, and use some lower layers as lineholder-focused layers as a backup.",
      };
    default:
      return {
        label: "Lineholder preferred, reserve as backup",
        guidance:
          "Default behavior: prioritize lineholder flying with reserve as a backup in lower layers.",
      };
  }
}

export async function POST(req: Request) {
  try {
    ensureApiKey();

    if (!ALL_PAIRINGS.length) {
      return NextResponse.json(
        {
          error:
            "No trips found inside data/pairings.json. The file loaded, but I could not find any array of trip objects.",
        },
        { status: 500 }
      );
    }

    const body = (await req.json()) as Record<string, unknown>;

    const domicile = typeof body["domicile"] === "string" ? body["domicile"] : "UNKNOWN";
    const seat = typeof body["seat"] === "string" ? body["seat"] : "UNKNOWN";
    const equipment =
      typeof body["equipment"] === "string" ? body["equipment"] : "UNKNOWN";
    const seniorityPercent =
      typeof body["seniorityPercent"] === "number"
        ? body["seniorityPercent"]
        : null;

    const mustOffDays = typeof body["mustOffDays"] === "string" ? body["mustOffDays"] : "";
    const wantOffDays = typeof body["wantOffDays"] === "string" ? body["wantOffDays"] : "";
    const idealSchedule =
      typeof body["idealSchedule"] === "string" ? body["idealSchedule"] : undefined;

    const statusPreferenceCode =
      (typeof body["statusPreference"] === "string"
        ? body["statusPreference"]
        : null) || "lineholder_preferred";
    const { label: statusLabel, guidance: statusGuidance } =
      describeStatusPreference(statusPreferenceCode);

    if (!idealSchedule || typeof idealSchedule !== "string") {
      return NextResponse.json(
        { error: "Missing 'idealSchedule' text in request body." },
        { status: 400 }
      );
    }

    const pairingsForPilot = getPairingsForThisRequest();

    const rulesJson = JSON.stringify(pbsRules, null, 2);
    const pairingsJson = JSON.stringify(pairingsForPilot, null, 2);

    const pilotProfile = `
DOMICILE: ${domicile}
SEAT: ${seat}
EQUIPMENT: ${equipment}
APPROXIMATE BIDDING SENIORITY: ${
      seniorityPercent != null ? seniorityPercent + "%" : "not specified"
    }

DAYS THAT MUST BE OFF (hard constraints):
${mustOffDays || "None explicitly specified."}

DAYS THAT ARE PREFERRED OFF (soft constraints):
${wantOffDays || "None explicitly specified."}

IDEAL SCHEDULE NARRATIVE:
${idealSchedule}
`.trim();

    const prompt = `
You are a PBS (Preferential Bidding System) assistant for American Airlines pilots, and you must think in terms of the actual AA PBS interface.

STATUS PREFERENCE:
- Code: ${statusPreferenceCode}
- Description: ${statusLabel}
- Guidance: ${statusGuidance}

Pilot profile and preferences are provided in a structured way:

${pilotProfile}

Use this information to infer realistic goals based on domicile, seat, equipment, approximate seniority, must-have days off, want-off days, and the narrative description of the ideal schedule.

AA PBS INTERFACE ELEMENTS (you must speak this language):

1) DAYS OFF PROPERTIES (Days Off tab)
   - Examples: "Maximize Weekend Days Off", "Day Off on Date", etc.
   - Each property can apply to layers 1–7.
   - Individual date OFF requests can be "MUST OFF" or "PREFER OFF" at specific layers.

2) PAIRING ID ON DATE (Pairing tab)
   - Example: "L17673 on Thursday, December 25".
   - Each entry specifies a pairing ID AND a date.
   - Each entry is tied to layers 1–7.

3) LINE / PAIRING PROPERTIES (Line / Pairing tabs)
   - Examples: "Minimize TAFB", "Allow Double-Up", "Allow Co-Terminal Mix Within Work Block",
     "Reduce Post Work Block Days Off By 1", etc.
   - Each property can be active in some or all layers (1–7).
   - These apply to REGULAR (lineholder) layers, not reserve layers.

4) RESERVE PROPERTIES (Reserve tab)
   For layers that are reserve layers, you have these key controls:
   - "Avoid Lineholder" (boolean)
   - "Reserve Line Preference" (one of: "S", "L", "S-L", "L-S")
   - "Reserve Work Block Size" with Min and Max (integers, e.g., 3–6 days)
   - "Prefer Fly Through Days" (can be left blank, or list dates where the pilot prefers to fly through instead of have a day off)
   - "Waive Reserve Block of 4 Days Off" (boolean)
   - "Allow Single Reserve Day Off" (boolean)
   - "Waive First Day of Month DFP Requirement" (boolean)

You will receive:
1) The pilot's structured biographical info and preferences (above).
2) A machine-readable JSON ruleset describing PBS rules and constraints.
3) A JSON list of actual trip pairings for this bid month (a subset from the real bid packet).

YOUR GOALS:
- Interpret the pilot's preferences realistically from the structured info.
- Respect the PBS rules from the JSON ruleset.
- Respect the status preference when deciding which layers are lineholder-focused vs reserve-focused.
- Use only the provided trip pairings when thinking about what the pilot can actually hold.
- Choose specific trips and patterns from the pairings list that best match the pilot's goals and the rules.
- Build a realistic and effective set of PBS bidding layers for a mid-seniority pilot at the given base/seat/equipment.
- Output recommendations in a structure that maps directly to:
  * Days Off Properties
  * Pairing ID on Date entries
  * Line / Pairing Properties (for lineholder layers)
  * Reserve Properties (for reserve layers)
  * And layer applicability (1–7) for each item.

Assume layers 1–7 are prioritized from most strict (Layer 1) to most relaxed (Layer 7).

PBS RULESET (JSON):
${rulesJson}

TRIP PAIRINGS SAMPLE (JSON):
${pairingsJson}

OUTPUT FORMAT (IMPORTANT):
Return ONLY valid JSON (no commentary, no extra text) with this exact structure:

{
  "summary": "2–4 sentence description of the overall bidding strategy, referencing rules, trips, seniority, and how it respects the status preference.",
  "daysOffProperties": [
    {
      "name": "Maximize Weekend Days Off",
      "layers": [1, 2, 3, 4, 5, 6, 7]
    }
  ],
  "dayOffRequests": [
    {
      "date": "2025-12-24",
      "strength": "must",
      "layers": [1, 2, 3]
    }
  ],
  "pairingRequests": [
    {
      "tripNumber": "L17673",
      "date": "2025-12-25",
      "layers": [1, 2, 3, 4],
      "comment": "Explain why this pairing supports the strategy."
    }
  ],
  "lineProperties": [
    {
      "name": "Minimize TAFB",
      "layers": [1, 2, 3, 4, 5, 6, 7]
    }
  ],
  "reserveProperties": [
    {
      "layer": 7,
      "isReserveLayer": true,
      "avoidLineholder": true,
      "reserveLinePreference": "S-L",
      "workBlockMin": 3,
      "workBlockMax": 5,
      "preferFlyThroughDays": ["2025-12-12"],
      "waiveReserveBlockOf4DaysOff": true,
      "allowSingleReserveDayOff": true,
      "waiveFirstDayDFPRequirement": false,
      "notes": "Explain how this reserve setup supports the pilot's goals."
    }
  ],
  "notes": "Optional extra comments or caveats about the strategy, including how the bid type preference and seniority were applied."
}

Rules for your answer:
- The response MUST be valid JSON.
- The word "json" appears in these instructions to satisfy JSON mode requirements.
- You MUST respect the status preference when deciding whether layers are lineholder-focused, reserve-focused, or a mix.
- 'reserveLinePreference' MUST be one of: "S", "L", "S-L", "L-S" when provided.
- 'layer' in reserveProperties should be an integer 1–7 indicating which PBS layer is a reserve layer.
- 'workBlockMin' and 'workBlockMax' should be reasonable integers (e.g., 2–7).
- If status preference is "lineholder_only", 'reserveProperties' should be empty.
- If status preference is "reserve_only", 'lineProperties' may be minimal or empty, and 'reserveProperties' should define most layers.
- Only use trip numbers that exist in the provided TRIP PAIRINGS SAMPLE.
- Dates in 'dayOffRequests', 'pairingRequests', and 'preferFlyThroughDays' must be valid for the bid month represented by the pairings JSON.
- Use lower layer numbers (1–3) for strict "must" constraints and higher layers (4–7) for softer preferences or backup patterns.
- Make layers realistic, not self-contradictory, and ordered by importance to the pilot.
- Do NOT output anything before or after the JSON. Only return a single JSON object.
`;

    const response = await openai.responses.create({
      model: "gpt-4.1",
      input: prompt,
      text: {
        format: { type: "json_object" },
      },
    });

    const text = (response as { output_text?: string }).output_text ?? "{}";

    let jsonResult;
    try {
      jsonResult = JSON.parse(text);
    } catch {
      jsonResult = { raw: text };
    }

    return NextResponse.json(jsonResult);
  } catch (err: unknown) {
    console.error("PBS API error:", err);

    const msg = (() => {
      if (typeof err === "string") return err;
      if (isRecord(err)) {
        const responseData = err["response"];
        if (
          isRecord(responseData) &&
          isRecord(responseData["data"]) &&
          isRecord(responseData["data"]["error"])
        ) {
          const nestedMessage = responseData["data"]["error"]["message"];
          if (typeof nestedMessage === "string") return nestedMessage;
        }

        const message = err["message"];
        if (typeof message === "string") return message;
      }
      return "Server error calling OpenAI";
    })();

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

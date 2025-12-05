import { parseBidPdf } from "@/lib/bidPacketParser";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return Response.json(
        { error: "No PDF uploaded" },
        { status: 400 },
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const result = await parseBidPdf(buffer, file.name || "uploaded.pdf");
    return Response.json(result);
  } catch (error) {
    console.error("Failed to parse bid PDF", error);
    return Response.json(
      { error: "Unable to parse PDF" },
      { status: 500 },
    );
  }
}

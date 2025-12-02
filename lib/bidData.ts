import bos737Dec2025 from "../data/json/BOS_737_DEC2025.json";

export type Bos737Dec2025Packet = typeof bos737Dec2025;

export function getBos737Dec2025Packet(): Bos737Dec2025Packet {
  return bos737Dec2025;
}

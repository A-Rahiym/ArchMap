import path from "node:path";

export const ARC_MAP_WORKSPACE =
  process.env.ARC_MAP_WORKSPACE || path.join(process.cwd(), ".workspace");

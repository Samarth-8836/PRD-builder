import path from "node:path";
import { FileStorage } from "./file-storage";
import type { IStorage } from "./types";

export * from "./types";
export { FileStorage } from "./file-storage";

let cached: IStorage | null = null;

export function getStorage(): IStorage {
  if (cached) return cached;
  const root =
    process.env.PRD_BUILDER_DATA_ROOT ?? path.join(process.cwd(), "data", "sessions");
  cached = new FileStorage(root);
  return cached;
}

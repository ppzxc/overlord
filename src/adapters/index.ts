import type { ProviderAdapter } from "../types.js";
import { goraebulAdapter } from "./goraebul.js";

export const adapters: Record<string, ProviderAdapter> = { goraebul: goraebulAdapter };

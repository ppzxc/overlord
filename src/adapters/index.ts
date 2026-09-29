import type { ProviderAdapter } from "../types.js";
import { donghaeAdapter } from "./donghae.js";
import { goraebulAdapter } from "./goraebul.js";

export const adapters: Record<string, ProviderAdapter> = { goraebul: goraebulAdapter, donghae: donghaeAdapter };

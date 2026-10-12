import type { ProviderAdapter } from "../types.js";
import { donghaeAdapter } from "./donghae.js";
import { goraebulAdapter } from "./goraebul.js";
import { knpsAdapter } from "./knps.js";

export const adapters: Record<string, ProviderAdapter> = { goraebul: goraebulAdapter, donghae: donghaeAdapter, knps: knpsAdapter };

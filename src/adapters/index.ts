import type { ProviderAdapter } from "../types.js";
import { bukguAdapter } from "./bukgu.js";
import { donghaeAdapter } from "./donghae.js";
import { goraebulAdapter } from "./goraebul.js";
import { jungguAdapter } from "./junggu.js";
import { knpsAdapter } from "./knps.js";
import { uljuAdapter } from "./ulju.js";
import { xticketAdapter } from "./xticket.js";

export const adapters: Record<string, ProviderAdapter> = { goraebul: goraebulAdapter, donghae: donghaeAdapter, knps: knpsAdapter, xticket: xticketAdapter, ulju: uljuAdapter, junggu: jungguAdapter, bukgu: bukguAdapter };

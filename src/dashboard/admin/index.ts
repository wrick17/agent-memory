// The owner tools behind Settings: today's pages under their old #/ routes.
import type { Part } from "../am";
import { backupsPages } from "./backups";
import { devicesPages } from "./devices";
import { draftPages } from "./draft";
import { movesPages } from "./moves";
import { profilesPages } from "./profiles";
import { reviewPages } from "./review";
import { routingPages } from "./routing";
import { wipePages } from "./wipe";

export const ADMIN: Part[] = [profilesPages, devicesPages, draftPages, reviewPages, backupsPages, routingPages, movesPages, wipePages];

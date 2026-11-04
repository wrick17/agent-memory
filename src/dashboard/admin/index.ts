// The Admin group: today's pages under their old #/ routes, in nav order. TG7 owns this folder.
import type { Part } from "../am";
import { aboutPages } from "./about";
import { backupsPages } from "./backups";
import { draftPages } from "./draft";
import { journalsPages } from "./journals";
import { mapPages } from "./map";
import { movesPages } from "./moves";
import { pathPages } from "./path";
import { profilesPages } from "./profiles";
import { reviewPages } from "./review";
import { routingPages } from "./routing";
import { timelinePages } from "./timeline";
import { wipePages } from "./wipe";
import { workPages } from "./work";

export const ADMIN: Part[] = [profilesPages, workPages, aboutPages, draftPages, mapPages, timelinePages, journalsPages, pathPages, reviewPages,
	backupsPages, routingPages, movesPages, wipePages];

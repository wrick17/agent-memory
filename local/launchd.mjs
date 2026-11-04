/* eslint-disable @typescript-eslint/no-unused-vars -- L0 stub: the parameters are the contract; the wave 1 owner removes this line with the stub bodies. */
// The daily launchd job (LO1 writes these, C1's install() calls them). Stub from L0. install prints the load command; it never runs it.

export const LABEL = "com.agent-memory.batch";
export const TEST_LABEL = "com.agent-memory.batch.test";

/** LABEL for the default home, TEST_LABEL for any other AGENT_MEMORY_HOME, so a test job never replaces the everyday one. */
export function launchdLabel(homeDir) {
	throw new Error("not_implemented:LO1");
}

/** ~/Library/LaunchAgents/<label>.plist */
export function plistPath(label) {
	throw new Error("not_implemented:LO1");
}

/** The plist XML: ProgramArguments [bin, "run", "--scheduled"], StartCalendarInterval { Hour: hour, Minute: 0 }, StandardErrorPath log. */
export function plist({ label, bin, hour, log }) {
	throw new Error("not_implemented:LO1");
}

/** `launchctl bootstrap gui/$(id -u) <file>`, printed for the owner. */
export function loadCommand(file) {
	throw new Error("not_implemented:LO1");
}

/** Whether launchd has the job loaded; null off macOS or when it cannot tell. Read only. */
export function launchdLoaded(label, { exec } = {}) {
	return null; // stub: LO1
}

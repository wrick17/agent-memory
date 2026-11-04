// The daily launchd job (LO1 writes these, C1's install() calls them). install prints the load command; it never runs it.
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const LABEL = "com.agent-memory.batch";
export const TEST_LABEL = "com.agent-memory.batch.test";
const DEFAULT_HOUR = 4;

/** LABEL for the default home, TEST_LABEL for any other AGENT_MEMORY_HOME, so a test job never replaces the everyday one. */
export function launchdLabel(homeDir) {
	return path.resolve(homeDir) === path.resolve(os.homedir(), ".agent-memory") ? LABEL : TEST_LABEL;
}

/** ~/Library/LaunchAgents/<label>.plist */
export function plistPath(label) {
	if (typeof label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(label)) throw new Error("launchd_label");
	return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * The plist XML: ProgramArguments [nodeExecutable, bin, "run", "--scheduled"], EnvironmentVariables { AGENT_MEMORY_HOME, PATH },
 * StartCalendarInterval { Hour: hour, Minute: 0 }, StandardErrorPath log. launchd starts jobs with a minimal PATH and no
 * AGENT_MEMORY_HOME, so the job names Node by absolute path, carries the installing PATH for the runner, and names its home.
 */
export function plist({ label, bin, hour, log, agentHome, nodeExecutable = process.execPath, runnerPath = process.env.PATH }) {
	if (typeof agentHome !== "string" || !path.isAbsolute(agentHome)) throw new Error("launchd_agent_home");
	if (typeof nodeExecutable !== "string" || !path.isAbsolute(nodeExecutable)) throw new Error("launchd_node_executable");
	if (typeof runnerPath !== "string" || !runnerPath) throw new Error("launchd_runner_path");
	const h = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_HOUR;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${xml(label)}</string>
	<key>ProgramArguments</key>
	<array><string>${xml(nodeExecutable)}</string><string>${xml(bin)}</string><string>run</string><string>--scheduled</string></array>
	<key>EnvironmentVariables</key>
	<dict><key>AGENT_MEMORY_HOME</key><string>${xml(agentHome)}</string><key>PATH</key><string>${xml(runnerPath)}</string></dict>
	<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>0</integer></dict>
	<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

const shellQuote = (s) => (/^[A-Za-z0-9_./~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** `launchctl bootstrap gui/$(id -u) <file>`, printed for the owner. */
export function loadCommand(file) {
	return `launchctl bootstrap gui/$(id -u) ${shellQuote(file)}`;
}

/** Whether launchd has the job loaded; null off macOS or when it cannot tell. Read only. */
export function launchdLoaded(label, { exec = spawnSync, platform = process.platform } = {}) {
	if (platform !== "darwin" || typeof label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(label)) return null;
	try {
		const r = exec("launchctl", ["print", `gui/${process.getuid()}/${label}`], { encoding: "utf8", stdio: "ignore", timeout: 5000 });
		if (r.error || typeof r.status !== "number") return null;
		return r.status === 0;
	} catch { return null; }
}

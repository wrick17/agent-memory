// local/*-player.js files are imported as text (wrangler.jsonc Text rule), not as code.
declare module "*-player.js" {
	const text: string;
	export default text;
}

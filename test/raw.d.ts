// Vite's ?raw imports, used to check deploy configuration from tests.
declare module "*?raw" {
	const text: string;
	export default text;
}

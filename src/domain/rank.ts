// Recall order for the owner model (section 12): inferred preferences rank below stated ones.

/**
 * Refills only the preference positions of a ranked list: non-inferred preferences first, then inferred ones, each group in
 * its current order. Every other kind keeps its place, so a list without an inferred preference comes back unchanged.
 */
export function statedFirst<T extends { kind: string; origin: string }>(ranked: T[]): T[] {
	const prefs = ranked.filter((h) => h.kind === "preference");
	const order = [...prefs.filter((h) => h.origin !== "inferred"), ...prefs.filter((h) => h.origin === "inferred")];
	let i = 0;
	return ranked.map((h) => (h.kind === "preference" ? order[i++]! : h));
}

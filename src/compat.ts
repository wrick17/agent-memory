// Which export schema versions each store restores (issue #5). Raise a floor only when a migration stops fitting older rows.
// Corpus restore keeps its exact match: v2 does not change the corpus schema.

/** The last v1 schemas, before the v2 storage entries: their rows fit the v2 tables by named columns, and the new tables start empty. */
export const RESTORABLE_FROM = { profile: 8, account: 6 } as const;

/** True for an integer from the store's floor to `current`, this code's own schema (its migration count); earlier and later exports are refused. */
export const restorable = (store: keyof typeof RESTORABLE_FROM, v: number, current: number): boolean =>
	Number.isInteger(v) && v >= RESTORABLE_FROM[store] && v <= current;

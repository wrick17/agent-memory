// Which export schema versions each store restores (v2 plan, MG0). Raise a floor only when a migration stops fitting older rows.
// Pure, like domain/: lint keeps src/*.ts out of the store folders' schema files, so each store passes its own current version.

/** The oldest restorable schema: the migration list lengths at e2c8672, before the v2 entries. Restore applies rows by named columns, so an older row fits. */
export const RESTORABLE_FROM = { profile: 8, account: 6 } as const;

/**
 * True when `v` is in the inclusive interval [RESTORABLE_FROM[store], current], where `current` is that store's migration list length
 * (PROFILE_MIGRATIONS.length or ACCOUNT_MIGRATIONS.length). Earlier and future schemas are refused. The corpus keeps its exact check.
 */
export const restorable = (store: keyof typeof RESTORABLE_FROM, v: unknown, current: number): boolean =>
	Number.isInteger(v) && (v as number) >= RESTORABLE_FROM[store] && (v as number) <= current;

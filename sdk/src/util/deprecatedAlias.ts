/**
 * Type helpers for expressing the Drift → Velocity rename surface.
 *
 * The SDK exposes paired keys (`velocityX` canonical, `driftX` deprecated) on
 * several config objects. {@link AtLeastOne} captures the "callers must supply
 * one of the two" contract at the type level so the runtime fallback in the
 * consuming class can rely on the value being present.
 */

/**
 * `AtLeastOne<A, B, T>` requires the caller to set at least one of two keys
 * (`A` canonical, `B` deprecated) to a value of type `T`. Whichever the caller
 * omits remains optional.
 *
 * Use this to express "rename `B` to `A`, but keep `B` accepted until the next
 * major" on a config object without dropping back to "both optional + runtime
 * throw".
 */
export type AtLeastOne<
	A extends string,
	B extends string,
	T
> =
	| ({ [K in A]: T } & { [K in B]?: T })
	| ({ [K in A]?: T } & { [K in B]: T });

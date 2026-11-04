/** The same default/floor/clamp rules as Lua arg_schema. */
export interface Spec<T> {
  normalize(value: unknown): T;
}
export interface IntegerOptions {
  default: number;
  min?: number;
  max?: number;
  floor?: boolean;
}
export function int(options: IntegerOptions): Spec<number> {
  return {
    normalize(value: unknown): number {
      if (typeof value !== "number") return options.default;
      let n = options.floor === false ? value : Math.floor(value);
      if (options.min !== undefined && n < options.min) n = options.min;
      if (options.max !== undefined && n > options.max) n = options.max;
      return n;
    },
  };
}
export function bool(options: { default: boolean }): Spec<boolean> {
  return {
    normalize: (value) =>
      typeof value === "boolean" ? value : options.default,
  };
}
type Fields = Record<string, Spec<unknown>>;
type Result<F extends Fields> = {
  [K in keyof F]: F[K] extends Spec<infer T> ? T : never;
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
export function parse<F extends Fields>(value: unknown, fields: F): Result<F> {
  const source = record(value),
    result: Record<string, unknown> = {};
  for (const key of Object.keys(fields))
    result[key] = fields[key]!.normalize(source[key]);
  return result as Result<F>;
}
export function object<F extends Fields>(options: {
  fields: F;
  default?: Partial<Result<F>>;
}): Spec<Result<F>> {
  return {
    normalize(value: unknown): Result<F> {
      const result = parse(value, options.fields);
      for (const key of Object.keys(options.default ?? {})) {
        const out = result as Record<string, unknown>;
        if (out[key] === undefined)
          out[key] = JSON.parse(
            JSON.stringify((options.default as Record<string, unknown>)[key]),
          );
      }
      return result;
    },
  };
}

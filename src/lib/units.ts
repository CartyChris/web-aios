/* ────────────────────────────────────────────────────────────────────────────
   Unit conversion — physical units only, no currencies (a currency rate is a
   live number from a network; a unit factor is a definition and can be
   tested once and trusted).

   Every linear unit is a factor to its dimension's base unit. Temperature is
   affine and handled on its own. Conversions across dimensions are refused
   rather than guessed.

   PURE. No DOM, no clock.
   ──────────────────────────────────────────────────────────────────────────── */

export type Dimension = "length" | "mass" | "volume" | "area" | "time" | "data" | "speed" | "temperature";

export interface Unit { id: string; name: string; dim: Dimension; factor: number; aliases: string[] }

const U = (id: string, name: string, dim: Dimension, factor: number, aliases: string[] = []): Unit => ({ id, name, dim, factor, aliases });

/** Base units: metre, kilogram, litre, square metre, second, byte, metre/second. */
export const UNITS: Unit[] = [
  U("mm", "millimetre", "length", 0.001, ["millimeter", "millimeters", "millimetres"]),
  U("cm", "centimetre", "length", 0.01, ["centimeter", "centimeters", "centimetres"]),
  U("m", "metre", "length", 1, ["meter", "meters", "metres"]),
  U("km", "kilometre", "length", 1000, ["kilometer", "kilometers", "kilometres"]),
  U("in", "inch", "length", 0.0254, ["inch", "inches", "\""]),
  U("ft", "foot", "length", 0.3048, ["foot", "feet", "'"]),
  U("yd", "yard", "length", 0.9144, ["yard", "yards"]),
  U("mi", "mile", "length", 1609.344, ["mile", "miles"]),
  U("nmi", "nautical mile", "length", 1852, ["nauticalmile"]),

  U("mg", "milligram", "mass", 1e-6, ["milligram", "milligrams"]),
  U("g", "gram", "mass", 0.001, ["gram", "grams"]),
  U("kg", "kilogram", "mass", 1, ["kilogram", "kilograms", "kilo", "kilos"]),
  U("t", "tonne", "mass", 1000, ["tonne", "tonnes", "metricton"]),
  U("oz", "ounce", "mass", 0.028349523125, ["ounce", "ounces"]),
  U("lb", "pound", "mass", 0.45359237, ["lbs", "pound", "pounds"]),
  U("st", "stone", "mass", 6.35029318, ["stone", "stones"]),

  U("ml", "millilitre", "volume", 0.001, ["milliliter", "milliliters", "millilitres"]),
  U("l", "litre", "volume", 1, ["liter", "liters", "litres", "litre"]),
  U("tsp", "teaspoon (US)", "volume", 0.00492892159375, ["teaspoon", "teaspoons"]),
  U("tbsp", "tablespoon (US)", "volume", 0.0147867647813, ["tablespoon", "tablespoons"]),
  U("floz", "fluid ounce (US)", "volume", 0.0295735295625, ["fl-oz", "fluidounce"]),
  U("cup", "cup (US)", "volume", 0.2365882365, ["cups"]),
  U("pt", "pint (US)", "volume", 0.473176473, ["pint", "pints"]),
  U("qt", "quart (US)", "volume", 0.946352946, ["quart", "quarts"]),
  U("gal", "gallon (US)", "volume", 3.785411784, ["gallon", "gallons"]),

  U("m2", "square metre", "area", 1, ["sqm", "m^2"]),
  U("km2", "square kilometre", "area", 1e6, ["sqkm", "km^2"]),
  U("ft2", "square foot", "area", 0.09290304, ["sqft", "ft^2"]),
  U("ha", "hectare", "area", 10_000, ["hectare", "hectares"]),
  U("acre", "acre", "area", 4046.8564224, ["acres", "ac"]),

  U("ms", "millisecond", "time", 0.001, ["millisecond", "milliseconds"]),
  U("s", "second", "time", 1, ["sec", "secs", "second", "seconds"]),
  U("min", "minute", "time", 60, ["mins", "minute", "minutes"]),
  U("h", "hour", "time", 3600, ["hr", "hrs", "hour", "hours"]),
  U("d", "day", "time", 86_400, ["day", "days"]),
  U("wk", "week", "time", 604_800, ["week", "weeks"]),

  U("b", "byte", "data", 1, ["byte", "bytes"]),
  U("kb", "kilobyte", "data", 1000, ["kilobyte", "kilobytes"]),
  U("mb", "megabyte", "data", 1e6, ["megabyte", "megabytes"]),
  U("gb", "gigabyte", "data", 1e9, ["gigabyte", "gigabytes"]),
  U("tb", "terabyte", "data", 1e12, ["terabyte", "terabytes"]),
  U("kib", "kibibyte", "data", 1024, ["kibibyte"]),
  U("mib", "mebibyte", "data", 1024 ** 2, ["mebibyte"]),
  U("gib", "gibibyte", "data", 1024 ** 3, ["gibibyte"]),

  U("mps", "metre/second", "speed", 1, ["m/s"]),
  U("kph", "kilometre/hour", "speed", 1000 / 3600, ["km/h", "kmh"]),
  U("mph", "mile/hour", "speed", 1609.344 / 3600, ["mi/h"]),
  U("kn", "knot", "speed", 1852 / 3600, ["knot", "knots", "kt"]),

  U("c", "Celsius", "temperature", 1, ["celsius", "degc", "°c"]),
  U("f", "Fahrenheit", "temperature", 1, ["fahrenheit", "degf", "°f"]),
  U("k", "Kelvin", "temperature", 1, ["kelvin"]),
];

export function findUnit(token: string): Unit | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  return UNITS.find((u) => u.id === t) ?? UNITS.find((u) => u.aliases.includes(t) || u.name.toLowerCase() === t) ?? null;
}

const toKelvin = (v: number, id: string) => (id === "c" ? v + 273.15 : id === "f" ? (v - 32) * (5 / 9) + 273.15 : v);
const fromKelvin = (k: number, id: string) => (id === "c" ? k - 273.15 : id === "f" ? (k - 273.15) * (9 / 5) + 32 : k);

export type ConvertResult = { ok: true; value: number; from: Unit; to: Unit } | { ok: false; reason: string };

export function convert(value: number, fromId: string, toId: string): ConvertResult {
  const from = findUnit(fromId);
  const to = findUnit(toId);
  if (!from) return { ok: false, reason: `Unknown unit "${fromId}".` };
  if (!to) return { ok: false, reason: `Unknown unit "${toId}".` };
  if (from.dim !== to.dim) return { ok: false, reason: `Cannot convert ${from.dim} (${from.name}) to ${to.dim} (${to.name}).` };
  if (!Number.isFinite(value)) return { ok: false, reason: "Not a number." };
  if (from.dim === "temperature") {
    const k = toKelvin(value, from.id);
    if (k < 0) return { ok: false, reason: "That is below absolute zero." };
    return { ok: true, value: fromKelvin(k, to.id), from, to };
  }
  return { ok: true, value: (value * from.factor) / to.factor, from, to };
}

/** "5 km to mi", "72F in C", "3.5 cups -> ml". Null when the text is not a conversion. */
export function parseConversion(text: string): { value: number; from: string; to: string } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*([a-z°"'/^0-9-]+?)\s+(?:to|in|as|->)\s+([a-z°"'/^0-9-]+)\s*$/i.exec(text);
  if (!m) return null;
  if (!findUnit(m[2]) || !findUnit(m[3])) return null;
  return { value: Number(m[1]), from: m[2], to: m[3] };
}

export function unitsFor(dim: Dimension): Unit[] {
  return UNITS.filter((u) => u.dim === dim);
}

export const DIMENSIONS: Dimension[] = ["length", "mass", "volume", "area", "time", "data", "speed", "temperature"];

/** Up to 10 significant digits, no trailing zeros, no exponent for ordinary sizes. */
export function formatNumber(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e15 || a < 1e-9) return v.toExponential(6);
  return String(Number(v.toPrecision(10)));
}

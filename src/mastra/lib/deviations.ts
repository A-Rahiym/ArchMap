/** Shared deviation helpers — used by compareBaseline and history (base vs head diff). */

/**
 * Checks whether a Tailwind value uses arbitrary syntax such as `p-[13px]` or `bg-[#ff0000]`.
 */
export function isArbitraryValue(value: string): boolean {
  return value.includes("[") && value.includes("]");
}

/**
 * Reports whether a styling category has declared token values available.
 */
export function isDeclaredCategory(
  category: "color" | "spacing" | "typography" | "radius" | "shadow",
  declaredSets: {
    colors: Set<string>;
    spacing: Set<string>;
    typography: Set<string>;
    radius: Set<string>;
  }
): boolean {
  if (category === "color") return declaredSets.colors.size > 0;
  if (category === "spacing") return declaredSets.spacing.size > 0;
  if (category === "typography") return declaredSets.typography.size > 0;
  if (category === "radius") return declaredSets.radius.size > 0;
  return false;
}

/**
 * Classifies a single spacing value against declared/inferred sets.
 * Returns whether it should be considered expected (not a deviation).
 */
export function isExpectedSpacing(
  value: string,
  declaredSpacing: Set<string>,
  inferredSpacing: Set<string>,
  hasDeclaredSpacing: boolean
): boolean {
  const isArbitrary = isArbitraryValue(value);
  if (isArbitrary) return false;
  if (hasDeclaredSpacing) {
    for (const k of declaredSpacing) {
      if (value.endsWith(`-${k}`) || value === k) return true;
    }
    return false;
  }
  return inferredSpacing.has(value);
}

/**
 * Gets severity for a spacing deviation based on arbitrary and baseline source.
 */
export function severityForSpacing(
  value: string,
  expectedSource: "declared" | "inferred",
  frequency: number
): "low" | "medium" | "high" {
  if (isArbitraryValue(value)) return "high";
  if (expectedSource === "declared") return "medium";
  return frequency === 1 ? "medium" : "low";
}

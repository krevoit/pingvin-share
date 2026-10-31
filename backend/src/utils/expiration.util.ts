import * as moment from "moment";

const RELATIVE_EXPIRATION_REGEX =
  /^(\d{1,5})-(minute|hour|day|week|month|year)s?$/;

/**
 * Parses a relative expiration such as "30-minutes", "1-hour" or "7-days".
 * Returns `null` for "never". Throws if the value is not valid.
 */
export function parseRelativeExpiration(value: string): Date | null {
  if (value === "never") return null;

  const match = RELATIVE_EXPIRATION_REGEX.exec(value ?? "");
  if (!match) throw new Error("Invalid expiration");

  const amount = parseInt(match[1], 10);
  if (amount < 1) throw new Error("Invalid expiration");

  return moment()
    .add(amount, `${match[2]}s` as moment.unitOfTime.DurationConstructor)
    .toDate();
}

export function isValidRelativeExpiration(value: string) {
  try {
    parseRelativeExpiration(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an expiration date (null = never) is beyond the configured maximum.
 * A max of 0 means "no maximum".
 */
export function exceedsMaxExpiration(
  expiration: Date | null,
  max: { value: number; unit: string },
) {
  if (!max || max.value === 0) return false;
  if (expiration === null) return true;
  return (
    expiration >
    moment()
      .add(max.value, max.unit as moment.unitOfTime.DurationConstructor)
      .toDate()
  );
}

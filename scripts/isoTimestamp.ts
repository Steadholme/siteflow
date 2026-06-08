const isoTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function timezoneOffsetMinutes(zone: string) {
  if (zone === "Z") {
    return 0;
  }

  const sign = zone[0] === "+" ? 1 : -1;
  const hours = Number(zone.slice(1, 3));
  const minutes = Number(zone.slice(4, 6));

  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    return undefined;
  }

  return sign * (hours * 60 + minutes);
}

export function strictIsoTimestampValue(value: unknown) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : undefined;
  const match = raw?.match(isoTimestampPattern);

  if (!raw || !match) {
    return undefined;
  }

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, fractionRaw, zone] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const millisecond = Number((fractionRaw ?? "").padEnd(3, "0"));
  const offset = timezoneOffsetMinutes(zone);

  if (
    offset === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }

  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offset * 60_000;
  const local = new Date(utcMillis + offset * 60_000);

  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== millisecond
  ) {
    return undefined;
  }

  return raw;
}

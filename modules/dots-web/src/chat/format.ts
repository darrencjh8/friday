import { lang } from "../i18n";
import { t } from "./strings";

/** Mise en forme des heures, jours, durées et tailles, dans la langue du navigateur. */
const locale = lang === "fr" ? "fr-FR" : "en-US";

const timeFormat = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: "long" });
const dateFormat = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "long" });
const dateYearFormat = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" });
const fullFormat = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" });

export const formatTime = (ts: number): string => timeFormat.format(ts);
export const formatFull = (ts: number): string => fullFormat.format(ts);

/** Clé de jour locale (AAAA-MM-JJ), pour comparer deux messages. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** « Aujourd'hui · 08:15 », « Hier · 22:04 », « lundi · 09:30 », « mar. 4 novembre · 10:00 ». */
export function dayLabel(ts: number, now = Date.now()): string {
  const startOf = (x: number) => new Date(new Date(x).toDateString()).getTime();
  const days = Math.round((startOf(now) - startOf(ts)) / 86_400_000);
  const time = formatTime(ts);
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (days === 0) return `${t.today} · ${time}`;
  if (days === 1) return `${t.yesterday} · ${time}`;
  if (days > 1 && days < 7) return `${capital(weekdayFormat.format(ts))} · ${time}`;
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return `${capital((sameYear ? dateFormat : dateYearFormat).format(ts))} · ${time}`;
}

const decimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** « 1.2 s » / « 1,2 s », « 2 min 05 », comme formatDuration de ToolTrail.kt. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${decimal.format(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min ${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
}

/** « 0:42 » pour un vocal. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatSize(bytes: number | undefined): string {
  if (bytes == null || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${decimal.format(bytes / 1024 / 1024)} MB`;
}

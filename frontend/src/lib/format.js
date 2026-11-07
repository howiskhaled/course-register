export const DAY_NAME = { U: "Sunday", M: "Monday", T: "Tuesday", W: "Wednesday", R: "Thursday", F: "Friday", S: "Saturday" };
export const DAY_SHORT = { U: "Sun", M: "Mon", T: "Tue", W: "Wed", R: "Thu", F: "Fri", S: "Sat" };

export const fmtDate = (iso) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const fmtClock = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

export const fmtNum = (n) => Number(n).toLocaleString("en-US");

export const plural = (n, one, many = one + "s") => `${fmtNum(n)} ${n === 1 ? one : many}`;

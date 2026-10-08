// Natural-ish time parsing for /remind. Returns epoch ms or null.
export function parseWhen(input, now = Date.now()) {
  const s = input.trim();

  // 相対: 30秒後 / 10分後 / 2時間後 / 3日後
  const rel = s.match(/^(\d+)\s*(秒|分|時間|日)後?$/);
  if (rel) {
    const n = Number(rel[1]);
    const mult = { '秒': 1e3, '分': 6e4, '時間': 36e5, '日': 864e5 }[rel[2]];
    return now + n * mult;
  }
  // English relative: "10 min", "in 2 hours", "3 days"
  const relEn = s.match(/^(?:in\s+)?(\d+)\s*(s|sec(?:ond)?s?|min(?:ute)?s?|m|h|hrs?|hours?|d|days?)\s*(?:from now)?$/i);
  if (relEn) {
    const n = Number(relEn[1]);
    const u = relEn[2].toLowerCase();
    const mult = u.startsWith('s') ? 1e3 : (u === 'm' || u.startsWith('min')) ? 6e4 : (u === 'h' || u.startsWith('hr') || u.startsWith('hour')) ? 36e5 : 864e5;
    return now + n * mult;
  }
  // ISO / Date.parse 可能な形式
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s.replace(' ', 'T'));
    return Number.isNaN(t) ? null : t;
  }
  // English day + time: "tomorrow 9am", "today 18:30", "9:30 pm"
  const dayEn = s.match(/^(today|tomorrow)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (dayEn) {
    const d = new Date(now);
    let hh = Number(dayEn[2]);
    if (dayEn[4]) { hh = hh % 12; if (dayEn[4].toLowerCase() === 'pm') hh += 12; }
    const mm = Number(dayEn[3] ?? 0);
    d.setHours(hh, mm, 0, 0);
    if (dayEn[1]?.toLowerCase() === 'tomorrow') d.setDate(d.getDate() + 1);
    else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const hmEn = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (hmEn) {
    const d = new Date(now);
    let hh = Number(hmEn[1]) % 12;
    if (hmEn[3].toLowerCase() === 'pm') hh += 12;
    d.setHours(hh, Number(hmEn[2] ?? 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // 明日/明後日/今日 + 時刻: 「明日9時」「明後日 18:30」「9:00」
  const day = s.match(/^(今日|明日|明後日)?\s*(\d{1,2})(?:時|:)(\d{1,2})?分?$/);
  if (day) {
    const d = new Date(now);
    const offset = { '今日': 0, '明日': 1, '明後日': 2 }[day[1]] ?? null;
    const hh = Number(day[2]);
    const mm = Number(day[3] ?? 0);
    d.setHours(hh, mm, 0, 0);
    if (offset !== null) {
      d.setDate(d.getDate() + offset);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    } else if (d.getTime() <= now) {
      d.setDate(d.getDate() + 1);
    }
    return d.getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export function fmtTs(ms) {
  const sec = Math.floor(ms / 1000);
  return `<t:${sec}:F> (<t:${sec}:R>)`;
}

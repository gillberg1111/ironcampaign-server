function dateFromString(s) {
  if (!s) return null;
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return d;
}

function stringFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function expandRule(rule, from, to) {
  const start = dateFromString(rule.start_date);
  if (!start) return [];

  const end = rule.end_date ? dateFromString(rule.end_date) : null;
  const effectiveEnd = end && end < to ? end : to;
  const fromDay = startOfDay(from);
  const results = [];

  switch (rule.recurrence) {
    case 'once': {
      const sDay = startOfDay(start);
      if (sDay >= fromDay && sDay <= startOfDay(effectiveEnd)) {
        results.push({ date: sDay, key: rule.start_date });
      }
      break;
    }
    case 'interval': {
      const interval = Math.max(1, rule.interval_days ?? 1);
      let current = startOfDay(start);
      const limit = startOfDay(effectiveEnd);
      while (current <= limit) {
        if (current >= fromDay) {
          results.push({ date: current, key: stringFromDate(current) });
        }
        current = addDays(current, interval);
      }
      break;
    }
    case 'weekly': {
      const mask = rule.weekday_mask ?? 0;
      let current = startOfDay(start);
      const limit = startOfDay(effectiveEnd);
      while (current <= limit) {
        const wd = (current.getDay() + 6) % 7; // 0=Mon ... 6=Sun
        const bit = 1 << wd;
        if ((mask & bit) !== 0 && current >= fromDay) {
          results.push({ date: current, key: stringFromDate(current) });
        }
        current = addDays(current, 1);
      }
      break;
    }
  }

  return results;
}

export function expandOccurrences(rules, from, to, sessions) {
  const results = [];
  for (const rule of rules) {
    if (rule.deleted) continue;
    const occurrences = expandRule(rule, from, to);
    for (const { date, key } of occurrences) {
      const done = sessions.some(s => {
        // Explicit occurrence link wins: a session completed FOR a calendar day marks that day.
        if (s.scheduled_date) return s.scheduled_date === key;
        // Same rule but no explicit link: count it only for the day the session actually
        // happened. A bare rule-uuid match would mark EVERY occurrence of a recurring rule
        // done after a single session (one Push Day completes all future Push Days).
        if (s.schedule_rule_uuid && s.schedule_rule_uuid === rule.uuid) {
          return stringFromDate(new Date(s.date * 1000)) === key; // s.date is SECONDS
        }
        return false;
      });
      results.push({
        date,
        source: { type: 'rule', rule },
        name: rule.name,
        templateUUID: rule.template_uuid,
        plannedWorkoutUUID: rule.planned_workout_uuid,
        done,
      });
    }
  }
  return results.sort((a, b) => a.date - b.date);
}

export function expandSagaWorkouts(saga, chapters, plannedWorkouts, from, to, sessions) {
  const results = [];
  if (!saga.start_date) return results;

  const sagaStart = dateFromString(saga.start_date);
  if (!sagaStart) return results;

  const fromDay = startOfDay(from);

  for (const ch of chapters) {
    if (ch.deleted) continue;
    for (const pw of plannedWorkouts) {
      if (pw.chapter_uuid !== ch.uuid || pw.deleted) continue;
      const dayOffset = ch.week_index * 7 + pw.day_index;
      const date = addDays(sagaStart, dayOffset);
      const dateDay = startOfDay(date);
      if (dateDay < fromDay || dateDay > startOfDay(to)) continue;

      const key = stringFromDate(date);
      const done = sessions.some(s => {
        if (s.planned_workout_uuid === pw.uuid) return true;
        if (s.scheduled_date === key) return true;
        return false;
      });

      results.push({
        date: dateDay,
        source: { type: 'sagaWorkout', plannedWorkout: pw, sagaName: saga.name, chapterName: ch.name },
        name: pw.name,
        templateUUID: pw.template_uuid,
        plannedWorkoutUUID: pw.uuid,
        done,
      });
    }
  }
  return results.sort((a, b) => a.date - b.date);
}

'use strict';

// --report: what the agents did over the last n days, per day and project.
// Turns and tokens come from the logs; active time is the minutes in which a
// session logged events at most five minutes apart (see parsers.js active()).
// Parallel sessions in one project count each minute once.

const path = require('path');
const { dayKey } = require('./parsers');

// Local midnight n - 1 days before now, so --days 1 means today.
function since(days, now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}

function projectOf(s) {
  if (!s.cwd) return '(unknown)';
  return `${s.agent === 'copilot' ? 'workspace-' : ''}${path.basename(s.cwd)}`;
}

// sessions: the watcher's session objects. Returns plain data, newest day first.
function build(sessions, { days = 7, now = Date.now(), privacy = false } = {}) {
  const from = dayKey(since(days, now));
  const to = dayKey(now);
  const byDay = new Map();
  for (const s of sessions) {
    if (!s.days) continue;
    const project = projectOf(s);
    for (const [day, d] of Object.entries(s.days)) {
      if (day < from || day > to) continue;
      if (!d.turns && !d.tokens && !d.minutes.size) continue;
      if (!byDay.has(day)) byDay.set(day, { minutes: new Set(), projects: new Map() });
      const bucket = byDay.get(day);
      if (!bucket.projects.has(project)) {
        bucket.projects.set(project, { turns: 0, tokens: 0, minutes: new Set(), sessions: 0, agents: new Set(), titles: [] });
      }
      const p = bucket.projects.get(project);
      p.turns += d.turns;
      p.tokens += d.tokens;
      for (const m of d.minutes) { p.minutes.add(m); bucket.minutes.add(m); }
      p.agents.add(s.agent);
      if (!s.subagent) {
        p.sessions += 1;
        if (s.title && !privacy && !p.titles.includes(s.title)) p.titles.push(s.title);
      }
    }
  }

  const out = { from, to, days: [] };
  for (const day of [...byDay.keys()].sort().reverse()) {
    const bucket = byDay.get(day);
    const projects = [...bucket.projects.entries()].map(([name, p]) => ({
      name,
      minutes: p.minutes.size,
      turns: p.turns,
      tokens: p.tokens,
      sessions: p.sessions,
      agents: [...p.agents].sort(),
      titles: p.titles.slice(0, 3),
    })).sort((a, b) => b.minutes - a.minutes || b.turns - a.turns || a.name.localeCompare(b.name));
    out.days.push({
      day,
      minutes: bucket.minutes.size,
      turns: projects.reduce((n, p) => n + p.turns, 0),
      tokens: projects.reduce((n, p) => n + p.tokens, 0),
      projects,
    });
  }
  return out;
}

function duration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function turns(n) {
  return `${n} turn${n === 1 ? '' : 's'}`;
}

function tokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

// Pipes and newlines would break a Markdown table row.
function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}

function markdown(r) {
  const lines = [`# Agent report ${r.from === r.to ? r.to : `${r.from} – ${r.to}`}`, ''];
  if (!r.days.length) {
    lines.push('No agent activity in this period.');
    return lines.join('\n') + '\n';
  }
  if (r.days.length > 1) {
    const total = (k) => r.days.reduce((n, d) => n + d[k], 0);
    lines.push(`**Total:** ${duration(total('minutes'))} active · ${turns(total('turns'))} · ${tokens(total('tokens'))} tokens`, '');
  }
  for (const d of r.days) {
    lines.push(`## ${d.day}`, '');
    lines.push(`${duration(d.minutes)} active · ${turns(d.turns)} · ${tokens(d.tokens)} tokens`, '');
    lines.push('| Project | Active | Turns | Tokens | Sessions | Agents | Worked on |');
    lines.push('|---|--:|--:|--:|--:|---|---|');
    for (const p of d.projects) {
      lines.push(`| ${cell(p.name)} | ${duration(p.minutes)} | ${p.turns} | ${tokens(p.tokens)} | ${p.sessions} | ${p.agents.join(', ')} | ${cell(p.titles.join(' · '))} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { build, markdown, since };

// Synthetic events only.
const assert = require('node:assert/strict');
const test = require('node:test');
const { newSession, applyClaude, applyCodex, dayKey } = require('../src/parsers');
const report = require('../src/report');

const MIN = 60_000;
const HOUR = 60 * MIN;
// Noon local time, so a few hours either way stays on the same day.
const NOON = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const DAY = 86_400_000;
const at = (ms) => new Date(ms).toISOString();

function codex(id, cwd, times, { subagent = false, tokens = 0 } = {}) {
  const s = newSession('codex', id, null);
  applyCodex(s, { type: 'session_meta', timestamp: at(times[0]), payload: { cwd, ...(subagent ? { parent_thread_id: 'p' } : {}) } });
  for (const t of times) applyCodex(s, { type: 'event_msg', timestamp: at(t), payload: { type: 'task_started' } });
  if (tokens) {
    applyCodex(s, { type: 'event_msg', timestamp: at(times[times.length - 1]), payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: tokens, cached_input_tokens: 0, output_tokens: 0 } } } });
  }
  return s;
}

test('sessions keep per-day turns, tokens and active minutes; long gaps are not active time', () => {
  const s = newSession('claude', 'a', null);
  const yesterday = NOON - DAY;
  for (const t of [yesterday, yesterday + 2 * MIN, NOON, NOON + 4 * MIN, NOON + 30 * MIN]) {
    applyClaude(s, { type: 'user', timestamp: at(t), message: { role: 'user', content: 'Go' } });
  }
  applyClaude(s, { type: 'assistant', timestamp: at(NOON + 30 * MIN), message: { id: 'm1', role: 'assistant',
    usage: { input_tokens: 100, output_tokens: 20 }, content: [] } });
  assert.equal(s.days[dayKey(yesterday)].turns, 2);
  assert.equal(s.days[dayKey(yesterday)].minutes.size, 3, 'minutes 0, 1 and 2');
  assert.equal(s.days[dayKey(NOON)].turns, 3);
  assert.equal(s.days[dayKey(NOON)].tokens, 120);
  assert.equal(s.days[dayKey(NOON)].minutes.size, 5, 'the 26-minute gap is not counted');
});

test('the report merges parallel sessions per project and counts each minute once', () => {
  const a = codex('a', '/w/shop', [NOON, NOON + 2 * MIN], { tokens: 1000 });
  const b = codex('b', '/w/shop', [NOON + MIN, NOON + 3 * MIN], { tokens: 500 });
  const sub = codex('c', '/w/shop', [NOON, NOON + MIN], { subagent: true, tokens: 50 });
  const other = codex('d', '/w/blog', [NOON + 10 * MIN, NOON + 11 * MIN]);
  a.title = 'Checkout | refunds';
  const r = report.build([a, b, sub, other], { days: 1, now: NOON + HOUR });
  assert.equal(r.days.length, 1);
  const [day] = r.days;
  const shop = day.projects.find((p) => p.name === 'shop');
  assert.equal(shop.minutes, 4, 'minutes 0 to 3, overlapping sessions counted once');
  assert.equal(shop.turns, 6, 'subagent turns count');
  assert.equal(shop.tokens, 1550);
  assert.equal(shop.sessions, 2, 'a subagent is not a separate session');
  assert.deepEqual(shop.titles, ['Checkout | refunds']);
  assert.equal(day.minutes, 6, 'shop 4 + blog 2');
  assert.equal(day.projects[0].name, 'shop', 'busiest project first');

  const md = report.markdown(r);
  assert.match(md, /Checkout \\\| refunds/, 'pipes in titles are escaped');
  assert.match(md, /\| shop \| 4m \| 6 \| 2k \| 2 \| codex \|/);
});

test('the report window covers the requested days and private mode drops titles', () => {
  const old = codex('a', '/w/old', [NOON - 3 * DAY, NOON - 3 * DAY + MIN]);
  const recent = codex('b', '/w/new', [NOON - DAY, NOON - DAY + MIN]);
  recent.title = 'Secret plan';
  const r = report.build([old, recent], { days: 2, now: NOON, privacy: true });
  assert.deepEqual(r.days.map((d) => d.day), [dayKey(NOON - DAY)]);
  assert.deepEqual(r.days[0].projects[0].titles, []);
  assert.equal(report.markdown(report.build([], { days: 1, now: NOON })).includes('No agent activity'), true);
});

#!/usr/bin/env node
/**
 * OpenGrafo Concurrency & Load Test Suite
 * No external dependencies — uses native fetch (Node 18+)
 */

const API = 'http://localhost:4000/graphql';
const EMAIL = 'admin@demo.opengrafo.io';
const PASSWORD = 'Demo1234';

// ─── GQL helper ─────────────────────────────────────────────────────────────

async function gql(query, variables = {}, token = null) {
  const start = performance.now();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(API, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });
    const ms = performance.now() - start;
    if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}` };
    const json = await res.json();
    if (json.errors) return { ok: false, ms, error: json.errors[0]?.message ?? 'GQL error' };
    return { ok: true, ms, data: json.data };
  } catch (e) {
    return { ok: false, ms: performance.now() - start, error: e.message };
  }
}

// ─── Stats helpers ───────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(times) {
  if (!times.length) return { avg: 0, p95: 0, p99: 0 };
  const s = [...times].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { avg: Math.round(avg), p95: Math.round(percentile(s, 95)), p99: Math.round(percentile(s, 99)) };
}

// ─── Setup: login + get a real CI id ────────────────────────────────────────

async function setup() {
  console.log('⚙  Setup: authenticating…');
  const r = await gql(`mutation { login(email: "${EMAIL}", password: "${PASSWORD}") { token } }`);
  if (!r.ok) { console.error('  ✗ Login failed:', r.error); process.exit(1); }
  const token = r.data.login.token;
  console.log('  ✓ Authenticated');

  console.log('⚙  Setup: fetching a real CI id for topology…');
  // Try servers first, then applications
  let ciId = null;
  const srv = await gql(`query { servers { items { id } } }`, {}, token);
  if (srv.ok && srv.data.servers?.items?.length) {
    ciId = srv.data.servers.items[0].id;
    console.log(`  ✓ CI id (server): ${ciId}`);
  } else {
    const app = await gql(`query { applications { items { id } } }`, {}, token);
    if (app.ok && app.data.applications?.items?.length) {
      ciId = app.data.applications.items[0].id;
      console.log(`  ✓ CI id (application): ${ciId}`);
    } else {
      ciId = 'UNKNOWN';
      console.warn('  ⚠ No CI found — topology tests will likely error');
    }
  }
  return { token, ciId };
}

// ─── Query definitions ───────────────────────────────────────────────────────

function makeQueries(ciId) {
  return {
    incidents: `query { incidents { items { id title severity status createdAt } } }`,
    changes: `query { changes { items { id title type priority status createdAt } } }`,
    servers: `query { servers { items { id name status environment ownerGroup { id name } createdAt } } }`,
    applications: `query { applications { items { id name status environment ownerGroup { id name } createdAt } } }`,
    anomalyStats: `query { anomalyStats { total critical high medium low open falsePositive acceptedRisk } }`,
    topology: `query { topology(selectedCiId: "${ciId}", maxHops: 2) { nodes { id name type status incidentCount changeCount } edges { source target type } } }`,
  };
}

const CREATE_INCIDENT = `mutation { createIncident(input: { title: "Load test incident", severity: "low", description: "test" }) { id } }`;
const RUN_ANOMALY_SCAN = `mutation { runAnomalyScanner }`;

// ─── TEST 1: Load Test ───────────────────────────────────────────────────────

async function runLoadTest(token, ciId) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  TEST 1 — LOAD TEST (batch parallele crescenti)');
  console.log('══════════════════════════════════════════════════════');
  const queries = makeQueries(ciId);
  const concurrencies = [10, 50, 100, 200];
  const results = {}; // results[queryName][concurrency] = { avg, p95, p99, errors, errPct }

  for (const [name, query] of Object.entries(queries)) {
    results[name] = {};
    process.stdout.write(`  ${name.padEnd(14)}`);
    let totalErrors = 0;
    let totalReqs = 0;

    for (const conc of concurrencies) {
      const batch = Array.from({ length: conc }, () => gql(query, {}, token));
      const responses = await Promise.all(batch);
      const times = responses.filter(r => r.ok).map(r => r.ms);
      const errors = responses.filter(r => !r.ok).length;
      totalErrors += errors;
      totalReqs += conc;
      const s = stats(times);
      results[name][conc] = { ...s, errors, errPct: ((errors / conc) * 100).toFixed(1) };
      process.stdout.write(` [${conc}: ${s.avg}ms]`);
    }
    const totalErrPct = ((totalErrors / totalReqs) * 100).toFixed(1);
    results[name].totalErrPct = totalErrPct;
    console.log(` errors: ${totalErrPct}%`);
  }
  return results;
}

// ─── TEST 2: Multi-User (30 seconds) ─────────────────────────────────────────

async function runMultiUser(token, ciId) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  TEST 2 — MULTI-USER (20 utenti virtuali, 30s)');
  console.log('══════════════════════════════════════════════════════');
  const queries = makeQueries(ciId);
  const DURATION = 30_000;
  const DELAY = () => 100 + Math.random() * 400;

  const accumulators = {
    'list incidents': { times: [], errors: 0 },
    'list changes': { times: [], errors: 0 },
    'create incident': { times: [], errors: 0 },
    'list CI': { times: [], errors: 0 },
    'topology': { times: [], errors: 0 },
    'anomaly scan': { times: [], errors: 0 },
  };

  const stopped = { value: false };

  async function virtualUser(opName, queryFn) {
    while (!stopped.value) {
      const r = await queryFn();
      const acc = accumulators[opName];
      if (r.ok) acc.times.push(r.ms);
      else acc.errors++;
      if (!stopped.value) await new Promise(res => setTimeout(res, DELAY()));
    }
  }

  let hop = 1;
  const users = [
    ...Array.from({ length: 5 }, () => virtualUser('list incidents', () => gql(queries.incidents, {}, token))),
    ...Array.from({ length: 5 }, () => virtualUser('list changes', () => gql(queries.changes, {}, token))),
    ...Array.from({ length: 3 }, () => virtualUser('create incident', () => gql(CREATE_INCIDENT, {}, token))),
    ...Array.from({ length: 3 }, (_, i) => virtualUser('list CI', () =>
      i % 2 === 0 ? gql(queries.servers, {}, token) : gql(queries.applications, {}, token)
    )),
    ...Array.from({ length: 2 }, () => {
      const h = ((hop++ - 1) % 3) + 1;
      const q = `query { topology(selectedCiId: "${ciId}", maxHops: ${h}) { nodes { id } edges { source target type } } }`;
      return virtualUser('topology', () => gql(q, {}, token));
    }),
    ...Array.from({ length: 2 }, () => virtualUser('anomaly scan', () => gql(RUN_ANOMALY_SCAN, {}, token))),
  ];

  process.stdout.write('  Running 30s');
  const ticker = setInterval(() => process.stdout.write('.'), 2000);
  await new Promise(res => setTimeout(res, DURATION));
  stopped.value = true;
  clearInterval(ticker);
  await Promise.allSettled(users);
  console.log(' done');

  return accumulators;
}

// ─── TEST 3: Stress Test (ramp-up 60s) ───────────────────────────────────────

async function runStressTest(token, ciId) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  TEST 3 — STRESS TEST (ramp-up 60s)');
  console.log('══════════════════════════════════════════════════════');
  const queries = makeQueries(ciId);

  const phases = [
    { users: 10, duration: 10_000 },
    { users: 30, duration: 10_000 },
    { users: 60, duration: 10_000 },
    { users: 100, duration: 10_000 },
    { users: 150, duration: 10_000 },
    { users: 200, duration: 10_000 },
  ];

  const phaseResults = [];

  for (const phase of phases) {
    process.stdout.write(`  ${phase.users} users (${phase.duration / 1000}s)…`);
    const stopped = { value: false };
    const times = [];
    const errors = { count: 0 };
    let reqCount = 0;
    const phaseStart = performance.now();

    function pickQuery(idx) {
      const roll = Math.random();
      if (roll < 0.70) {
        // 70% read light
        const lightReads = [queries.incidents, queries.changes, queries.servers];
        return lightReads[idx % lightReads.length];
      } else if (roll < 0.90) {
        // 20% heavy
        return idx % 2 === 0 ? queries.topology : queries.applications;
      } else {
        // 10% write
        return CREATE_INCIDENT;
      }
    }

    async function stressUser(idx) {
      while (!stopped.value) {
        const q = pickQuery(idx);
        const r = await gql(q, {}, token);
        if (!stopped.value) {
          reqCount++;
          if (r.ok) times.push(r.ms);
          else errors.count++;
        }
        if (!stopped.value) await new Promise(res => setTimeout(res, 50 + Math.random() * 150));
      }
    }

    const users = Array.from({ length: phase.users }, (_, i) => stressUser(i));
    await new Promise(res => setTimeout(res, phase.duration));
    stopped.value = true;
    await Promise.allSettled(users);

    const elapsed = (performance.now() - phaseStart) / 1000;
    const s = stats(times);
    const errPct = reqCount > 0 ? ((errors.count / reqCount) * 100).toFixed(1) : '0.0';
    const rps = Math.round(reqCount / elapsed);
    phaseResults.push({ users: phase.users, avg: s.avg, p95: s.p95, errPct, rps, reqCount });
    console.log(` avg=${s.avg}ms err=${errPct}% rps=${rps}`);
  }

  return phaseResults;
}

// ─── Report renderer ─────────────────────────────────────────────────────────

function pad(str, len, right = false) {
  const s = String(str ?? '—');
  return right ? s.padStart(len) : s.padEnd(len);
}

function printLoadTestTable(results) {
  console.log('\n╔══════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                              LOAD TEST RESULTS                                      ║');
  console.log('╠════════════════╦════════════╦════════════╦════════════╦════════════╦════════════════╣');
  console.log('║ Query          ║  10 conc   ║  50 conc   ║  100 conc  ║  200 conc  ║  Total Errors  ║');
  console.log('╠════════════════╬════════════╬════════════╬════════════╬════════════╬════════════════╣');
  for (const [name, r] of Object.entries(results)) {
    const c = [10, 50, 100, 200].map(c => {
      const d = r[c];
      return `${d.avg}ms p95:${d.p95}`.padEnd(10);
    });
    console.log(
      `║ ${pad(name, 14)} ║ ${pad(c[0], 10)} ║ ${pad(c[1], 10)} ║ ${pad(c[2], 10)} ║ ${pad(c[3], 10)} ║ ${pad(r.totalErrPct + '%', 14)} ║`
    );
  }
  console.log('╚════════════════╩════════════╩════════════╩════════════╩════════════╩════════════════╝');
}

function printMultiUserTable(acc) {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║               MULTI-USER TEST (30s) RESULTS                 ║');
  console.log('╠══════════════════╦══════════╦══════════╦══════════╦══════════╣');
  console.log('║ Operation        ║  Count   ║ Avg (ms) ║ P95 (ms) ║  Errors  ║');
  console.log('╠══════════════════╬══════════╬══════════╬══════════╬══════════╣');
  for (const [op, data] of Object.entries(acc)) {
    const s = stats(data.times);
    const count = data.times.length + data.errors;
    console.log(
      `║ ${pad(op, 16)} ║ ${pad(count, 8, true)} ║ ${pad(s.avg, 8, true)} ║ ${pad(s.p95, 8, true)} ║ ${pad(data.errors, 8, true)} ║`
    );
  }
  const totalReqs = Object.values(acc).reduce((s, d) => s + d.times.length + d.errors, 0);
  const totalErrors = Object.values(acc).reduce((s, d) => s + d.errors, 0);
  console.log('╠══════════════════╬══════════╩══════════╩══════════╩══════════╣');
  console.log(`║ TOTAL            ║ ${pad(totalReqs, 8, true)}   errors: ${pad(totalErrors, 4, true)}  (${((totalErrors/totalReqs)*100).toFixed(1)}%)   ║`);
  console.log('╚══════════════════╩═══════════════════════════════════════════╝');
}

function printStressTable(phaseResults) {
  let breakingPoint = null;
  let degradationPoint = null;

  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                    STRESS TEST RESULTS (60s)                    ║');
  console.log('╠════════════╦══════════════╦══════════════╦════════════╦══════════╣');
  console.log('║ Users      ║   Avg (ms)   ║   P95 (ms)   ║  Error %   ║   RPS    ║');
  console.log('╠════════════╬══════════════╬══════════════╬════════════╬══════════╣');
  for (const r of phaseResults) {
    const flags = [];
    if (!degradationPoint && r.avg > 1000) { degradationPoint = r.users; flags.push('⚠ DEGRADATION'); }
    if (!breakingPoint && parseFloat(r.errPct) > 5) { breakingPoint = r.users; flags.push('💥 BREAKING'); }
    const note = flags.join(' ');
    console.log(
      `║ ${pad(r.users, 10)} ║ ${pad(r.avg + 'ms', 12, true)} ║ ${pad(r.p95 + 'ms', 12, true)} ║ ${pad(r.errPct + '%', 10, true)} ║ ${pad(r.rps, 8, true)} ║  ${note}`
    );
  }
  console.log('╠════════════╩══════════════╩══════════════╩════════════╩══════════╣');
  if (degradationPoint)
    console.log(`║ ⚠  DEGRADATION (avg > 1s) @ ${pad(degradationPoint + ' users', 36)} ║`);
  else
    console.log('║ ⚠  DEGRADATION (avg > 1s): not reached within 200 users         ║');
  if (breakingPoint)
    console.log(`║ 💥 BREAKING POINT (err > 5%) @ ${pad(breakingPoint + ' users', 32)} ║`);
  else
    console.log('║ 💥 BREAKING POINT (err > 5%): not reached within 200 users       ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       OpenGrafo — Concurrency Load Test Suite        ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Target: ${API}`);
  console.log(`  Start:  ${new Date().toISOString()}`);

  const { token, ciId } = await setup();

  const t0 = performance.now();
  const loadResults = await runLoadTest(token, ciId);
  const multiUserResults = await runMultiUser(token, ciId);
  const stressResults = await runStressTest(token, ciId);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  console.log(`\n  Total test duration: ${elapsed}s`);

  printLoadTestTable(loadResults);
  printMultiUserTable(multiUserResults);
  printStressTable(stressResults);

  console.log(`\n  Completed at: ${new Date().toISOString()}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

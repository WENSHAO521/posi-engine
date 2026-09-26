#!/usr/bin/env node
/**
 * GLOBAL-INDEX-1.0 automated cycle driver (posi-data/GLOBAL-INDEX-1.0-SPEC.md).
 *
 * One call advances the current cycle as far as the time budget allows and
 * records where it stopped, so a scheduled job can call it repeatedly:
 *
 *   harvest  -> OpenAlex + Crossref journal lists (resumable cursors)
 *   corpus   -> merged global corpus
 *   pcs      -> PCS-1.0 for every journal (run-pcs-etl.mjs, resumable)
 *   rank     -> PCS-Q edition (run-pcs-q.mjs)
 *   ready    -> edition built; the workflow publishes it, then --mark-published
 *   published-> a new cycle starts once --cycle-days have passed
 *
 *   node scripts/global/run-cycle.mjs --work work --curated <core.json> --curated <benchmark.json> \
 *     [--budget-minutes 330] [--cycle-days 30] [--concurrency 4] [--limit N]
 *
 * Writes <work>/cycle.json and, when a cycle finishes, prints `publish=true`
 * (also appended to $GITHUB_OUTPUT when set).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, appendFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { arg, flag } from './lib.mjs'

const all = name => { const o = []; for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === `--${name}`) o.push(process.argv[i + 1]); return o }
const work = resolve(arg('work', 'work'))
const curated = all('curated')
const budgetMs = Number(arg('budget-minutes', 330)) * 60_000
const cycleDays = Number(arg('cycle-days', 30))
const concurrency = arg('concurrency', '4')
const limit = arg('limit')
const deadline = Date.now() + budgetMs
const engineDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

if (!existsSync(work)) mkdirSync(work, { recursive: true })
const statePath = join(work, 'cycle.json')
const today = new Date().toISOString().slice(0, 10)
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf-8')) : null

const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2))
const log = msg => console.log(`[cycle ${state?.cycle_id ?? '-'}] ${msg}`)
const output = (k, v) => { console.log(`${k}=${v}`); if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`) }

// Called by the workflow after the edition has been committed to posi-data.
if (flag('mark-published')) {
  if (state?.stage === 'ready') { state.stage = 'published'; state.published_at = today; save(); log('marked published') }
  process.exit(0)
}

// Start a new cycle when there is none, or the finished one has aged out.
const ageDays = s => (Date.parse(today) - Date.parse(s.started_at)) / 86_400_000
if (!state || (state.stage === 'published' && ageDays(state) >= cycleDays)) {
  for (const f of readdirSync(work)) if (f !== 'cycle.json') rmSync(join(work, f), { recursive: true, force: true })
  state = { cycle_id: today, started_at: today, stage: 'harvest', history: [] }
  save()
  log('new cycle')
}

function run(script, args, { timeoutMs } = {}) {
  return new Promise(res => {
    const child = spawn(process.execPath, [join(engineDir, script), ...args], { stdio: 'inherit', cwd: engineDir })
    const t = timeoutMs ? setTimeout(() => { log(`time budget reached, stopping ${script}`); child.kill('SIGINT') }, timeoutMs) : null
    child.on('exit', code => { if (t) clearTimeout(t); res(code ?? 1) })
  })
}
const remaining = () => deadline - Date.now()
const step = (stage, note) => { state.history.push({ at: new Date().toISOString(), stage, note }); save() }

const oaFile = join(work, 'openalex-journals.jsonl')
const crFile = join(work, 'crossref-journals.jsonl')
const corpusFile = join(work, 'global-corpus.json')
const pcsDir = join(work, 'pcs')
const rankDir = join(work, 'pcs-q')
const lim = limit ? ['--limit', limit] : []

if (state.stage === 'harvest') {
  const a = await run('scripts/global/harvest-openalex-journals.mjs', ['--out', oaFile, ...lim], { timeoutMs: remaining() })
  const b = a === 0 ? await run('scripts/global/harvest-crossref-journals.mjs', ['--out', crFile, ...lim], { timeoutMs: remaining() }) : 1
  if (a === 0 && b === 0) { state.stage = 'corpus'; step('harvest', 'complete') } else step('harvest', 'interrupted, will resume')
}

if (state.stage === 'corpus' && remaining() > 60_000) {
  const code = await run('scripts/global/build-global-corpus.mjs', [
    '--openalex', oaFile, '--crossref', crFile, ...curated.flatMap(c => ['--curated', resolve(c)]), '--out', corpusFile,
  ])
  if (code === 0) { state.stage = 'pcs'; step('corpus', 'complete') }
}

if (state.stage === 'pcs' && remaining() > 60_000) {
  await run('scripts/run-pcs-etl.mjs', ['--corpus', corpusFile, '--out', pcsDir, '--concurrency', concurrency], { timeoutMs: remaining() - 30_000 })
  const total = JSON.parse(readFileSync(corpusFile, 'utf-8')).length
  const done = existsSync(join(pcsDir, 'journals')) ? readdirSync(join(pcsDir, 'journals')).length : 0
  state.pcs_progress = { done, total }
  if (done >= total) { state.stage = 'rank'; step('pcs', `complete ${done}/${total}`) } else step('pcs', `progress ${done}/${total}`)
}

if (state.stage === 'rank') {
  const code = await run('scripts/run-pcs-q.mjs', ['--pcs-dir', pcsDir, '--corpus', corpusFile, '--out', rankDir])
  if (code === 0) { state.stage = 'ready'; step('rank', 'edition built') }
}

save()
log(`stage: ${state.stage}${state.pcs_progress ? ` (pcs ${state.pcs_progress.done}/${state.pcs_progress.total})` : ''}`)
output('stage', state.stage)
output('cycle', state.cycle_id)
output('publish', state.stage === 'ready' ? 'true' : 'false')
// The corpus alone is enough for the journal directory; publish it as soon as it exists.
output('corpus_ready', existsSync(corpusFile) ? 'true' : 'false')

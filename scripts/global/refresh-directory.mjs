#!/usr/bin/env node
/**
 * Monthly journal directory refresh, independent of the ranking cycle.
 *
 * New journals appear every month, but the GLOBAL-INDEX cycle (run-cycle.mjs)
 * only harvests when a new ranking cycle starts, and a new cycle waits for the
 * last one to be published and 20 days old. This driver refreshes only the
 * journal corpus and the OpenAlex profiles, once a calendar month, with its
 * own work directory and state, so the journal directory stays current
 * whether or not a ranking edition is released that month.
 *
 *   harvest -> OpenAlex journals (public snapshot) + Crossref journal list
 *   corpus  -> merged global corpus
 *   done    -> the workflow releases it as journals-<YYYY-MM>
 *
 *   node scripts/global/refresh-directory.mjs --work dir-work \
 *     --curated <core.json> --curated <benchmark.json> [--budget-minutes 320] [--limit N]
 *
 * Resumable: one call advances as far as the time budget allows; the next
 * call in the same month continues (the Crossref harvest keeps its cursor).
 * A new month starts from an empty work directory. Writes <work>/directory.json
 * and prints month=, stage= and corpus_ready= (also to $GITHUB_OUTPUT).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, appendFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { arg } from './lib.mjs'

const all = name => { const o = []; for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === `--${name}`) o.push(process.argv[i + 1]); return o }
const work = resolve(arg('work', 'dir-work'))
const curated = all('curated')
const limit = arg('limit')
const deadline = Date.now() + Number(arg('budget-minutes', 320)) * 60_000
const engineDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const month = new Date().toISOString().slice(0, 7)

if (!existsSync(work)) mkdirSync(work, { recursive: true })
const statePath = join(work, 'directory.json')
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf-8')) : null
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2))
const log = msg => console.log(`[directory ${state?.month ?? '-'}] ${msg}`)
const output = (k, v) => { console.log(`${k}=${v}`); if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`) }
const step = (stage, note) => { state.history.push({ at: new Date().toISOString(), stage, note }); save() }

// A new month starts clean; an unfinished month resumes.
if (!state || state.month !== month) {
  for (const f of readdirSync(work)) rmSync(join(work, f), { recursive: true, force: true })
  state = { month, started_at: new Date().toISOString(), stage: 'harvest', openalex_done: false, crossref_done: false, history: [] }
  save()
  log('new month')
}

const remaining = () => deadline - Date.now()
function run(script, args) {
  return new Promise(res => {
    const child = spawn(process.execPath, [join(engineDir, script), ...args], { stdio: 'inherit', cwd: engineDir })
    const t = setTimeout(() => { log(`time budget reached, stopping ${script}`); child.kill('SIGINT') }, Math.max(0, remaining()))
    child.on('exit', code => { clearTimeout(t); res(code ?? 1) })
  })
}

const oaFile = join(work, 'openalex-journals.jsonl')
const crFile = join(work, 'crossref-journals.jsonl')
const corpusFile = join(work, 'global-corpus.json')
const issnMapFile = join(work, 'openalex-issn-map.json')
const lim = limit ? ['--limit', limit] : []

if (state.stage === 'harvest') {
  // The snapshot harvest takes minutes and is simply rerun if interrupted;
  // --limit test runs use the API harvester instead, as run-cycle.mjs does.
  if (!state.openalex_done) {
    const a = lim.length
      ? await run('scripts/global/harvest-openalex-journals.mjs', ['--out', oaFile, ...lim])
      : await run('scripts/global/harvest-openalex-snapshot.mjs', ['--out', oaFile, '--profiles', join(work, 'openalex-profiles.jsonl'), '--issn-map', issnMapFile])
    if (a === 0) { state.openalex_done = true; step('harvest', 'OpenAlex complete') }
  }
  if (state.openalex_done && !state.crossref_done && remaining() > 60_000) {
    const b = await run('scripts/global/harvest-crossref-journals.mjs', ['--out', crFile, ...lim])
    if (b === 0) { state.crossref_done = true; step('harvest', 'Crossref complete') }
  }
  if (state.openalex_done && state.crossref_done) { state.stage = 'corpus'; step('harvest', 'complete') } else step('harvest', 'interrupted, will resume')
}

if (state.stage === 'corpus' && remaining() > 60_000) {
  const code = await run('scripts/global/build-global-corpus.mjs', [
    '--openalex', oaFile, '--crossref', crFile, ...curated.flatMap(c => ['--curated', resolve(c)]), '--out', corpusFile,
    ...(existsSync(issnMapFile) ? ['--openalex-issn-map', issnMapFile] : []),
  ])
  if (code === 0) { state.stage = 'done'; step('corpus', 'complete') } else step('corpus', `failed (exit ${code})`)
}

log(`stage: ${state.stage}`)
output('month', state.month)
output('stage', state.stage)
output('corpus_ready', state.stage === 'done' && existsSync(corpusFile) ? 'true' : 'false')

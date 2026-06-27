// The autonomous self-improvement loop itself.
//
// Branch mode: all commits go to auto/improve-<timestamp>, never main.
// Daily cap: one branch per calendar day.
// User merges via /improve approve <branch>; mergeBranch() (approval.ts) handles it.
//
// Not started at extension load -- triggered on-demand from command dispatch.

import { log } from 'ion-sdk'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { HARNESS_DIR } from '../config'
import { logEvent } from '../memory/episodic'
import { runCommandAsync } from '../util/ionPrompt'
import { runCurator, loadUsage, saveUsage } from './curator'
import { createApproval } from '../approvals/index'
import { postPendingDigest } from '../discord/digest'
import { SYSTEM_PROMPT, loadImprovementHistory, readFiles, callLLM } from './prompt'
import { parseSuggestion, applyTextChange } from './suggestion'
import {
  git,
  branchesToday,
  getAllImproveBranches,
  branchDiffVsMain,
  createBranch,
  checkoutMain,
  deleteBranch,
  gitCommit,
  gitRevert,
  runTestsWithOutput,
  createScript,
  MAX_RETRIES,
} from './branches'

// ---------------------------------------------------------------------------
// Summary formatting
// ---------------------------------------------------------------------------

function formatSummary(changes: string[], durationMinutes: number): string {
  if (!changes.length) {
    return `ran for up to ${durationMinutes} minutes -- nothing to improve found.`
  }
  const committed = changes.filter((c) => c.startsWith('COMMITTED'))
  const reverted = changes.filter((c) => c.startsWith('REVERTED'))
  const skipped = changes.filter((c) => c.startsWith('SKIP') || c.startsWith('REJECTED'))
  const lines = [`self-improvement loop complete (${durationMinutes}min budget).`]
  if (committed.length) {
    lines.push(`\ncommitted ${committed.length} change(s):`)
    committed.forEach((c) => lines.push(`  - ${c.replace('COMMITTED: ', '')}`))
  }
  if (reverted.length) {
    lines.push(`\nreverted ${reverted.length} (tests failed):`)
    reverted.forEach((r) => lines.push(`  - ${r.replace('REVERTED (tests failed): ', '')}`))
  }
  if (skipped.length) {
    lines.push(`\nskipped ${skipped.length}:`)
    skipped.forEach((s) => lines.push(`  - ${s}`))
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Public API: run()
// ---------------------------------------------------------------------------

export async function run(durationMinutes = 15, focus = ''): Promise<string> {
  const existing = await branchesToday()
  if (existing.length) {
    const b = existing[0]!
    return (
      `daily cap reached -- branch ${b} already exists for today. ` +
      `Use /improve approve ${b} to merge it, or /improve reject to discard before running again.`
    )
  }

  const curatorSummary = runCurator()
  log.info('self_improvement: curator ran', { summary: curatorSummary })
  logEvent('self_improvement', 'inbox_item', {
    routine: 'self_improvement',
    text: `Script curator: ${curatorSummary}`,
  })

  const branch = await createBranch()
  log.info('improve: created branch', { branch })

  const deadline = Date.now() + durationMinutes * 60_000
  const changes: string[] = []
  const focusStr = focus || 'general -- look for any system prompt improvements'

  const retryCount = new Map<string, number>()
  let llmFailed = false

  try {
    const historyBlock = loadImprovementHistory()
    while (Date.now() < deadline) {
      const fileContents = readFiles()
      const alreadyChanged = changes.length ? changes.join('\n') : '(none yet)'
      const userPromptParts = [
        `Focus area: ${focusStr}`,
        '',
        '=== CURRENT SOURCE FILES (the ONLY place <old> text can come from) ===',
        fileContents,
        '',
        '=== FEEDBACK FROM PREVIOUS ITERATIONS THIS SESSION ===',
        alreadyChanged,
      ]
      if (historyBlock) {
        userPromptParts.push('', '---', historyBlock, '---')
      }
      userPromptParts.push(
        '',
        'Identify ONE improvement. Copy <old> text verbatim from the source files above.',
        'Output the XML-tagged change, or output DONE if nothing clear remains.',
      )
      const userPrompt = userPromptParts.join('\n')

      let response: string
      try {
        response = await callLLM(SYSTEM_PROMPT, userPrompt)
      } catch (err) {
        log.warn('improve: LLM call failed', { err: String(err) })
        llmFailed = true
        break
      }

      log.info('improve: LLM response', { preview: response.slice(0, 400).replace(/\n/g, ' ') })

      const suggestion = parseSuggestion(response)
      if (!suggestion) {
        log.info('improve: model returned DONE or unparseable -- stopping')
        break
      }

      if (suggestion.action === 'create') {
        const { filepath, content, reason } = suggestion
        const result = await createScript(filepath, content)
        if (result.startsWith('Error')) {
          changes.push(`SKIP (create failed): ${filepath} -- ${result}`)
          continue
        }
        const { passed: scriptPassed, output: scriptOutput } = await runTestsWithOutput()
        if (scriptPassed) {
          await gitCommit(filepath, reason)
          changes.push(`COMMITTED (new script): ${filepath} -- ${reason}`)
          log.info('improve: committed new script', { filepath, reason })
          retryCount.delete(filepath)
        } else {
          const attempts = (retryCount.get(filepath) ?? 0) + 1
          retryCount.set(filepath, attempts)
          if (attempts < MAX_RETRIES) {
            changes.push(
              `FAILED_ATTEMPT (${attempts}/${MAX_RETRIES}): ${filepath} -- tests failed. Fix the script before proposing other changes.\n${scriptOutput}`
            )
            log.warn('improve: script test failure, retry', { filepath, attempts })
          } else {
            try { unlinkSync(join(HARNESS_DIR, filepath)) } catch { /* best effort */ }
            const basename = filepath.split('/').at(-1) ?? filepath
            const usage = loadUsage()
            delete usage[basename]
            saveUsage(usage)
            retryCount.delete(filepath)
            changes.push(`REVERTED (tests failed after ${MAX_RETRIES} attempts): ${filepath} -- ${reason}`)
            log.warn('improve: reverted new script after max retries', { filepath })
          }
        }
      } else {
        const { filepath, old, newText, reason } = suggestion
        const absPath = join(HARNESS_DIR, filepath)
        if (!existsSync(absPath)) {
          log.warn('improve: file not found', { filepath })
          changes.push(`SKIP (file not found): ${filepath} -- ${reason}`)
          continue
        }

        const result = applyTextChange(filepath, old, newText)
        if (result.startsWith('Error')) {
          if (result.includes('not found')) {
            changes.push(
              `REJECTED: the proposed <old> text was not in ${filepath}. ` +
              `Do not paraphrase, do not quote conversation history, ` +
              `and do not modify quote characters. Reason given: ${reason}`,
            )
          } else {
            changes.push(`SKIP (apply failed): ${filepath} -- ${result}`)
          }
          continue
        }

        const { passed, output } = await runTestsWithOutput()
        if (passed) {
          await gitCommit(filepath, reason)
          changes.push(`COMMITTED: ${filepath} -- ${reason}`)
          log.info('improve: committed', { reason })
          retryCount.delete(filepath)
        } else {
          const attempts = (retryCount.get(filepath) ?? 0) + 1
          retryCount.set(filepath, attempts)
          if (attempts < MAX_RETRIES) {
            changes.push(
              `FAILED_ATTEMPT (${attempts}/${MAX_RETRIES}): ${filepath} -- tests failed. Fix the change before proposing other edits.\n${output}`
            )
            log.warn('improve: test failure, retry', { filepath, attempts })
          } else {
            await gitRevert(filepath)
            retryCount.delete(filepath)
            changes.push(`REVERTED (tests failed after ${MAX_RETRIES} attempts): ${filepath} -- ${reason}`)
            log.warn('improve: reverted after max retries', { filepath })
          }
        }
      }
    }
  } finally {
    await checkoutMain()
  }

  const committed = changes.filter((c) => c.startsWith('COMMITTED'))

  if (!committed.length) {
    await deleteBranch(branch)
    if (llmFailed && !changes.length) {
      return `LLM call timed out after ${durationMinutes} minutes -- no changes made, branch deleted.`
    }
    return formatSummary(changes, durationMinutes)
  }

  // Guard: if another auto/improve-* branch already proposes the identical change, discard this one.
  const currentDiff = await branchDiffVsMain(branch)
  const allBranches = await getAllImproveBranches()
  for (const b of allBranches) {
    if (b === branch) continue
    const existingDiff = await branchDiffVsMain(b)
    if (existingDiff === currentDiff) {
      await checkoutMain()
      await deleteBranch(branch)
      log.warn('improve: duplicate proposal discarded', { kept: b, discarded: branch })
      return (
        `skipped — ${b} already proposes an identical change. ` +
        `Use /improve approve ${b} to merge it, or /improve reject ${b} to discard before running again.`
      )
    }
  }

  // Full lint + test check before surfacing the branch.
  const checkResult = await runCommandAsync('make', ['check'], {
    cwd: HARNESS_DIR,
    timeoutMs: 300_000,
  })
  if (checkResult.status === null) {
    await deleteBranch(branch)
    logEvent('improve', 'improvement_failed', { branch, reason: 'make check timed out' })
    return formatSummary(changes, durationMinutes) + `\nmake check timed out on branch ${branch} -- branch deleted.`
  }
  if (checkResult.status !== 0) {
    await deleteBranch(branch)
    logEvent('improve', 'improvement_failed', { branch, reason: 'make check failed after loop' })
    return formatSummary(changes, durationMinutes) + `\nmake check failed on branch ${branch} -- branch deleted.`
  }

  const pushResult = await git(['push', 'origin', branch])
  if (pushResult.status !== 0) {
    log.warn('improve: push failed', { stderr: pushResult.stderr })
    return (
      formatSummary(changes, durationMinutes) +
      `\nbranch ${branch} ready locally (push failed). Use /improve approve ${branch} to merge.`
    )
  }

  // Build diff excerpt for the approval record (first 2000 chars of the branch diff).
  let diffExcerpt = ''
  try {
    const diffR = await git(['diff', `main...${branch}`])
    diffExcerpt = diffR.stdout.slice(0, 2000)
  } catch { /* best effort */ }

  const committedFiles = committed.flatMap((c) => {
    const match = /^COMMITTED(?:\s+\([^)]+\))?: ([^ ]+)/.exec(c)
    return match?.[1] ? [match[1]] : []
  })

  // improve is always risky by definition (edits identity + config files).
  // github_run_id stores the branch name so applyApprovedImprove can find it.
  const approvalId = createApproval({
    kind: 'improve',
    github_run_id: branch,
    summary: `improve: ${committed.length} change(s) on ${branch}`,
    files_changed: committedFiles,
    diff_excerpt: diffExcerpt,
    risk_tier: 'risky',
  })

  try {
    await postPendingDigest()
  } catch (err) {
    log.warn('improve: postPendingDigest failed', { err: String(err) })
  }

  logEvent('improve', 'improve_awaiting_approval', { branch, approvalId, files: committedFiles })
  logEvent('improve', 'inbox_item', {
    routine: 'improve_branch',
    branch,
    text: (
      `Self-improvement branch ready: ${branch}. ` +
      `${committed.length} change(s) committed, make check passed. ` +
      `Approval #${approvalId} queued in Discord. ` +
      `Use /improve approve ${branch} to merge and deploy.`
    ),
    priority: 0.6,
  })

  return (
    formatSummary(changes, durationMinutes) +
    `\nbranch ${branch} pushed and ready for review (approval #${approvalId}). Use /improve approve ${branch} to merge and deploy.`
  )
}

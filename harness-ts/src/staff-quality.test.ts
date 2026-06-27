import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { ROUTING_VOCABULARY_RE } from './learning/index'

// ---------------------------------------------------------------------------
// Block A: ROUTING_VOCABULARY_RE covers all active staff
// ---------------------------------------------------------------------------

describe('ROUTING_VOCABULARY_RE covers all active staff', () => {
  const cases: [string, string][] = [
    ['researcher', 'researcher'],
    ['writer', 'writer'],
    ['eng_lead', 'engineering lead'],
    ['dev_backend', 'backend developer'],
    ['dev_frontend', 'frontend developer'],
    ['dev_infra', 'infra dev'],
    ['news_desk', 'news desk'],
    ['repo_steward', 'repo steward'],
    ['tech_advisor', 'technology advisor'],
    ['reflection_analyst', 'reflection analyst'],
    ['admin', 'admin'],
    ['chief_of_communications', 'chief of communications'],
    ['observability_watcher', 'observability'],
    ['knowledge_curator', 'knowledge curator'],
    ['personal_cfo', 'personal CFO'],
    ['security_analyst', 'security analyst'],
    ['wellness_coach', 'wellness coach'],
    ['devils_advocate', "devil's advocate"],
    ['chief_of_strategy', 'chief of strategy'],
    ['portfolio_manager', 'portfolio manager'],
    ['doc_steward', 'doc steward'],
    ['contacts_manager', 'contacts manager'],
    ['systems_engineer', 'systems engineer'],
    ['legal_reviewer', 'legal reviewer'],
    ['home_property', 'property manager'],
    ['entertainment_advisor', 'entertainment advisor'],
  ]

  for (const [id, phrase] of cases) {
    it(`matches phrase for ${id}: "${phrase}"`, () => {
      expect(ROUTING_VOCABULARY_RE.test(phrase)).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// Block B: staff.yaml schema integrity
// ---------------------------------------------------------------------------

interface StaffEntry {
  id: unknown
  title: unknown
  status: unknown
  when_to_call: unknown
  model_key: unknown
  [key: string]: unknown
}

interface StaffFile {
  staff: StaffEntry[]
}

const staffYamlPath = path.resolve(__dirname, '../../harness/config/staff.yaml')
const staffFile = yaml.load(readFileSync(staffYamlPath, 'utf8')) as StaffFile

describe('staff.yaml schema integrity', () => {
  for (const entry of staffFile.staff) {
    const id = typeof entry.id === 'string' ? entry.id : String(entry.id)

    it(`${id} has required fields`, () => {
      expect(typeof entry.id).toBe('string')
      expect((entry.id as string).length).toBeGreaterThan(0)

      expect(typeof entry.title).toBe('string')
      expect((entry.title as string).length).toBeGreaterThan(0)

      expect(typeof entry.status).toBe('string')
      expect((entry.status as string).length).toBeGreaterThan(0)

      expect(typeof entry.model_key).toBe('string')
      expect((entry.model_key as string).length).toBeGreaterThan(0)

      expect(entry.when_to_call).toBeDefined()
    })

    it(`${id} when_to_call is a non-empty array`, () => {
      expect(Array.isArray(entry.when_to_call)).toBe(true)
      expect((entry.when_to_call as unknown[]).length).toBeGreaterThanOrEqual(1)
    })
  }
})

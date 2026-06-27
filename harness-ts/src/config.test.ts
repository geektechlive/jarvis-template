// Tests for loadGraphitiConfig() in config.ts
// Validates URI → HTTP URL derivation and the enabled flag without touching the filesystem.
// Uses vi.resetModules() so HARNESS_DIR re-evaluates from env per test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('loadGraphitiConfig', () => {
  let tmpDir: string
  let configDir: string

  beforeEach(() => {
    vi.resetModules()
    tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-config-test-'))
    configDir = join(tmpDir, 'harness', 'config')
    mkdirSync(configDir, { recursive: true })
    process.env['JARVIS_DIR'] = tmpDir
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['JARVIS_DIR']
  })

  function writeModelsYaml(content: string): void {
    writeFileSync(join(configDir, 'models.yaml'), content, 'utf8')
  }

  async function getConfig() {
    const mod = await import('./config')
    return mod.loadGraphitiConfig()
  }

  it('returns enabled=true and derives correct HTTP URL from bolt URI', async () => {
    writeModelsYaml('graphiti:\n  enabled: true\n  neo4j_uri: bolt://192.0.2.10:7687\n  neo4j_user: neo4j\n')
    const cfg = await getConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.neo4jHttpUrl).toBe('http://192.0.2.10:7474')
  })

  it('returns enabled=false when enabled is false', async () => {
    writeModelsYaml('graphiti:\n  enabled: false\n  neo4j_uri: bolt://<nas-ip>:7687\n')
    const cfg = await getConfig()
    expect(cfg.enabled).toBe(false)
  })

  it('defaults to disabled when models.yaml is missing', async () => {
    const cfg = await getConfig()
    expect(cfg.enabled).toBe(false)
  })

  it('defaults to disabled when graphiti block is absent', async () => {
    writeModelsYaml('roles:\n  triage:\n    model: haiku\n')
    const cfg = await getConfig()
    expect(cfg.enabled).toBe(false)
  })

  it('returns localhost fallback URL when neo4j_uri is absent', async () => {
    writeModelsYaml('graphiti:\n  enabled: true\n')
    const cfg = await getConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.neo4jHttpUrl).toBe('http://localhost:7474')
  })

  it('handles bolt URI on non-default host', async () => {
    writeModelsYaml('graphiti:\n  enabled: true\n  neo4j_uri: bolt://192.0.2.5:7687\n')
    const cfg = await getConfig()
    expect(cfg.neo4jHttpUrl).toBe('http://192.0.2.5:7474')
  })
})

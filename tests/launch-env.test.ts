import { describe, it, expect } from 'vitest'
import { LAUNCH_ENV, buildLaunchEnv, parseProfile, parseSessionHandle } from '../src/launch-env.ts'

describe('parsers (read side)', () => {
  it('parseSessionHandle: trimmed non-empty else undefined', () => {
    expect(parseSessionHandle(undefined)).toBeUndefined()
    expect(parseSessionHandle('  ')).toBeUndefined()
    expect(parseSessionHandle('  s1 ')).toBe('s1')
  })

  it('parseProfile: trimmed non-empty else undefined (no profile = bare launch)', () => {
    expect(parseProfile(undefined)).toBeUndefined()
    expect(parseProfile('  ')).toBeUndefined()
    expect(parseProfile('  sample ')).toBe('sample')
  })
})

describe('buildLaunchEnv', () => {
  it('mints a session handle when none is given, and echoes it in env', () => {
    const { env, session } = buildLaunchEnv({ workspace: '/ws' })
    expect(session).toMatch(/[0-9a-f-]{36}/)
    expect(env[LAUNCH_ENV.SESSION]).toBe(session)
    expect(env[LAUNCH_ENV.WORKSPACE]).toBe('/ws')
  })

  it('passes a provided session handle through unchanged', () => {
    const { env, session } = buildLaunchEnv({ workspace: '/ws', session: 'fixed' })
    expect(session).toBe('fixed')
    expect(env[LAUNCH_ENV.SESSION]).toBe('fixed')
  })

  it('emits ONLY what is set — an unset knob is absent from env (falls to the reader default)', () => {
    const { env } = buildLaunchEnv({ workspace: '/ws' })
    expect(env).not.toHaveProperty(LAUNCH_ENV.PROFILE)
  })

  // Tool restriction — typed `tools` AND `nativeToolAllowlist` — is no longer a launch env: both
  // resolve daemon-side from the active agent-profile. buildLaunchEnv carries only the profile LOCATOR.

  it('profile: emitted when set (re-parses to input), omitted when unset (no profile)', () => {
    expect(buildLaunchEnv({ workspace: '/ws', profile: 'sample' }).env[LAUNCH_ENV.PROFILE]).toBe('sample')
    expect(parseProfile(buildLaunchEnv({ workspace: '/ws', profile: 'sample' }).env[LAUNCH_ENV.PROFILE])).toBe('sample')
    expect(buildLaunchEnv({ workspace: '/ws' }).env).not.toHaveProperty(LAUNCH_ENV.PROFILE)
  })

  it('never emits AU_MCP_TRACE (retired)', () => {
    const { env } = buildLaunchEnv({ workspace: '/ws', profile: 'p' })
    expect(Object.keys(env)).not.toContain('AU_MCP_TRACE')
  })
})

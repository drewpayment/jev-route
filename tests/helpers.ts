import { resolveConfig, type Config } from '../hooks/config.ts'

/** Config with defaults plus overrides in userConfig key form. */
export function cfg(overrides: Record<string, unknown> = {}): Config {
  return resolveConfig({ jev_api_key: 'test-key', ...overrides })
}

import { USER_CONFIG_PATH, readUserConfigValue } from '@clement_chsn/pi-shared/user-config';

export function readBraveApiKey({ env = process.env, filePath = USER_CONFIG_PATH } = {}) {
  return readUserConfigValue({ env, filePath, variable: 'BRAVE_API_KEY', service: 'Brave' });
}

export function readContext7ApiKey({ env = process.env, filePath = USER_CONFIG_PATH } = {}) {
  return readUserConfigValue({ env, filePath, variable: 'CONTEXT7_API_KEY', service: 'Context7' });
}

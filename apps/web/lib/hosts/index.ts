import { env } from '@/lib/env';
import type { HostName } from './types';

export function defaultHost(): HostName {
  return env.defaultRuntimeHost;
}

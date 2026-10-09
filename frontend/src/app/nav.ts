import type { IconName } from '../components/ui/Icon.tsx'

export interface NavEntry {
  path: string
  label: string
  icon: IconName
}

/** Hash routes served by the console. */
export const NAV: NavEntry[] = [
  { path: '/overview', label: 'Overview', icon: 'pulse' },
  { path: '/providers', label: 'Providers', icon: 'server' },
  { path: '/routing', label: 'Routing', icon: 'shuffle' },
  { path: '/playground', label: 'Playground', icon: 'play' },
  { path: '/usage', label: 'Usage & Cost', icon: 'chart' },
  { path: '/traffic', label: 'Traffic', icon: 'list' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
]

export const DEFAULT_ROUTE = '/overview'

export function routeFromHash(hash: string): string {
  const path = hash.replace(/^#/, '').split('?')[0] || '/'
  return NAV.some((n) => n.path === path) ? path : DEFAULT_ROUTE
}
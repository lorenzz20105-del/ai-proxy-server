/**
 * Types mirrored 1:1 from docs/API.md — the authoritative contract.
 * Field names here MUST match the backend exactly.
 */

/* ------------------------------------------------------------------ */
/* Error envelope                                                      */
/* ------------------------------------------------------------------ */

export interface ApiErrorBody {
  message: string
  type: string
  code: string
  param: string | null
  request_id: string | null
}

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

export interface HealthResponse {
  status: string
  version: string
  uptime_s: number
  accounts: { total: number; enabled: number; healthy: number; degraded: boolean }
  db: { ok: boolean; latency_ms: number }
  cache: { entries: number; hits: number; misses: number }
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

export interface ModelProxyInfo {
  accounts: string[] | null
  alias: boolean
  context_window: number | null
}

export interface ModelObject {
  id: string
  object: string
  owned_by: string
  proxy: ModelProxyInfo | null
}

export interface ModelList {
  object: string
  data: ModelObject[]
}

/* ------------------------------------------------------------------ */
/* Chat completions                                                    */
/* ------------------------------------------------------------------ */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatRequestBody {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  top_p?: number
  seed?: number
  stop?: string[]
  response_format?: { type: 'text' | 'json_object' }
  stream_options?: { include_usage: boolean }
  [key: string]: unknown
}

export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface ChatChoice {
  index: number
  message: ChatMessage
  finish_reason: string | null
}

export interface ChatCompletion {
  id: string
  object: string
  created: number
  model: string
  choices: ChatChoice[]
  usage: ChatUsage | null
}

export interface ChatChunkDelta {
  role?: string
  content?: string | null
}

export interface ChatChunkChoice {
  index: number
  delta: ChatChunkDelta
  finish_reason: string | null
}

export interface ChatChunk {
  id: string
  object: string
  created: number
  model: string
  choices: ChatChunkChoice[]
  usage?: ChatUsage | null
}

/** Headers added by the proxy on every upstream call. */
export interface ProxyResponseMeta {
  requestId: string | null
  account: string | null
  attempts: number | null
  latencyMs: number | null
  cache: 'HIT' | 'MISS' | 'BYPASS' | null
  upstreamStatus: number | null
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openai_compatible'
  | 'azure'
  | 'bedrock'
  | 'vertex'
  | 'groq'
  | 'together'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'ollama'
  | 'custom'
  | (string & {})

export type CircuitState = 'closed' | 'open' | 'half_open' | (string & {})

export interface AccountRateLimit {
  rpm: number | null
  tpm: number | null
  burst: number | null
  enabled: boolean
}

export interface AccountBudget {
  daily_usd: number | null
  monthly_usd: number | null
  spent_today_usd: number | null
}

export interface AccountRoutingOverride {
  strategy: string | null
  cost_multiplier: number | null
}

export interface AccountProxy {
  enabled: boolean
  url_masked: string | null
}

export interface AccountHealth {
  circuit: CircuitState
  consecutive_failures: number
  last_error: string | null
  last_success_ts: number | null
  avg_latency_ms: number | null
  success_rate: number | null
  in_flight: number
  disabled_until: number | null
}

export interface AccountCounters {
  requests: number
  errors: number
  tokens_in: number
  tokens_out: number
  cost_usd: number
}

/** Shape returned by GET /admin/accounts (secrets masked). */
export interface Account {
  name: string
  provider_type: ProviderType
  base_url: string | null
  api_key_masked: string | null
  models: string[]
  weight: number
  priority: number
  enabled: boolean
  models_exact: boolean
  rate_limit: AccountRateLimit
  budget: AccountBudget
  routing: AccountRoutingOverride
  proxy: AccountProxy
  location: string | null
  user_agent: string | null
  extra_headers: Record<string, string>
  health: AccountHealth
  counters: AccountCounters
}

/** Body accepted by POST /admin/accounts and PUT /admin/accounts/{name}. */
export interface AccountInput {
  name?: string
  provider_type?: ProviderType
  base_url?: string
  /** Full secret — write-only. Omit on update to keep the stored key. */
  api_key?: string
  models?: string[]
  weight?: number
  priority?: number
  enabled?: boolean
  models_exact?: boolean
  rate_limit?: Partial<AccountRateLimit>
  budget?: { daily_usd?: number | null; monthly_usd?: number | null }
  routing?: AccountRoutingOverride
  proxy?: { enabled?: boolean; url?: string | null }
  location?: string | null
  user_agent?: string | null
  extra_headers?: Record<string, string>
}

export interface AccountsResponse {
  accounts: Account[]
}

export interface AccountTestResult {
  name: string
  ok: boolean
  status: number | null
  latency_ms: number | null
  models_sampled: number | null
  error: string | null
}

export interface DeleteResponse {
  deleted: string
}

export interface StatusResponse {
  status: string
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

export type RoutingStrategy =
  | 'round_robin'
  | 'failover'
  | 'weighted'
  | 'random'
  | 'least_latency'
  | 'least_cost'
  | 'least_requests'
  | 'priority'
  | (string & {})

export interface RoutingRetry {
  max_attempts: number
  backoff_seconds: number
  max_backoff_seconds: number
  jitter: boolean
  retry_status_codes: number[]
}

export interface RoutingCircuitBreaker {
  failure_threshold: number
  success_threshold: number
  cooldown_seconds: number
  half_open_max_concurrency: number
}

export interface RoutingSessionAffinity {
  enabled: boolean
  ttl_seconds: number
  header: string
}

export interface RoutingCache {
  enabled: boolean
  ttl_seconds: number
  max_entries: number
  deterministic_only: boolean
  forward_client_caching_headers: boolean
}

export type ModelMatching = 'exact' | 'prefix' | (string & {})

export interface RoutingConfig {
  strategy: RoutingStrategy
  strategies: RoutingStrategy[]
  retry: RoutingRetry
  circuit_breaker: RoutingCircuitBreaker
  session_affinity: RoutingSessionAffinity
  cache: RoutingCache
  model_matching: ModelMatching
}

export type RoutingUpdate = Partial<Omit<RoutingConfig, 'strategies'>>

/* ------------------------------------------------------------------ */
/* Aliases                                                             */
/* ------------------------------------------------------------------ */

export interface AliasEntry {
  targets: string[]
  strategy: string | null
  created_ts: number | null
}

export interface AliasesResponse {
  aliases: Record<string, AliasEntry>
}

export interface AliasUpdateResponse {
  alias: string
  targets: string[]
}

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

export interface BudgetGlobal {
  daily_usd: number | null
  monthly_usd: number | null
  spent_today_usd: number | null
  spent_month_usd: number | null
  remaining_today_usd: number | null
  hard_stop: boolean
  window_utc: string | null
}

export interface BudgetAlert {
  threshold_pct: number
  fired: boolean
}

export interface BudgetKeyRow {
  key: string
  name: string
  daily_usd: number | null
  spent_today_usd: number | null
  rpm: number | null
  tpm: number | null
  models_allow: string[] | null
  models_deny: string[] | null
}

export interface BudgetResponse {
  global: BudgetGlobal
  alerts: BudgetAlert[]
  keys: BudgetKeyRow[]
}

export interface BudgetUpdate {
  daily_usd?: number | null
  monthly_usd?: number | null
  hard_stop?: boolean
  alerts?: number[]
}

/* ------------------------------------------------------------------ */
/* Usage & logs                                                        */
/* ------------------------------------------------------------------ */

export type UsageRange = '1h' | '24h' | '7d' | '30d' | 'all'

export interface UsageTotals {
  requests: number
  errors: number
  success_rate: number
  tokens_in: number
  tokens_out: number
  cost_usd: number
  cached_requests: number
  cache_hit_rate: number
  avg_latency_ms: number
  p95_latency_ms: number
}

export interface UsageBucket {
  bucket: string
  requests: number
  errors: number
  cost_usd: number
  tokens_in: number
  tokens_out: number
}

export interface UsageByAccount {
  name: string
  requests: number
  errors: number
  cost_usd: number
  tokens_in: number
  tokens_out: number
  success_rate: number
  avg_latency_ms: number
  circuit: CircuitState
}

export interface UsageByModel {
  model: string
  requests: number
  cost_usd: number
  tokens_in: number
  tokens_out: number
}

export interface UsageByKey {
  name: string
  requests: number
  cost_usd: number
}

export interface UsageResponse {
  range: UsageRange | string
  totals: UsageTotals
  timeline: UsageBucket[]
  by_account: UsageByAccount[]
  by_model: UsageByModel[]
  by_key: UsageByKey[]
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'warning' | 'error' | (string & {})
export type LogKind = 'request' | 'audit' | 'probe' | 'stream' | (string & {})

export interface LogEntry {
  id: string
  ts: number
  kind: LogKind
  level: LogLevel
  method: string | null
  path: string | null
  model: string | null
  requested_model: string | null
  account: string | null
  key_name: string | null
  session_id: string | null
  status: number | null
  attempts: number | null
  latency_ms: number | null
  ttft_ms: number | null
  stream: boolean
  cached: boolean
  prompt_tokens: number | null
  completion_tokens: number | null
  cost_usd: number | null
  error: string | null
  location: string | null
}

export interface LogsResponse {
  logs: LogEntry[]
  total: number
}

export interface LogsQuery {
  limit?: number
  account?: string
  model?: string
  status?: string
  kind?: string
  since?: string
  level?: string
}

export interface ClearLogsResponse {
  deleted: number
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

export interface KeyRecord {
  name: string
  key_masked: string
  created_ts: number | null
  last_used_ts: number | null
  daily_usd: number | null
  rpm: number | null
  tpm: number | null
  models_allow: string[] | null
  models_deny: string[] | null
  enabled: boolean
}

export interface KeysResponse {
  keys: KeyRecord[]
}

/** The full key is returned exactly once, on create. */
export interface CreatedKey extends Partial<KeyRecord> {
  name: string
  key: string
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export interface ServerConfig {
  host: string
  port: number
  request_timeout_s: number
  stream_timeout_s: number
}

export interface LimitsConfig {
  max_body_bytes: number
  max_concurrency: number
}

export interface CorsConfig {
  origins: string[]
}

export interface FeaturesConfig {
  cache: boolean
  retry: boolean
  circuit_breaker: boolean
  budget: boolean
  active_probe: boolean
  usage_accounting: boolean
}

export interface ServerConfigResponse {
  version: string
  data_dir: string
  db: string
  encryption: 'fernet' | 'plaintext' | (string & {})
  master_key_masked: string
  server: ServerConfig
  limits: LimitsConfig
  cors: CorsConfig
  features: FeaturesConfig
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export interface LocationsResponse {
  locations: Record<string, string[]>
}

export interface CacheStatus {
  enabled: boolean
  entries: number
  max_entries: number
  ttl_seconds: number
  hits: number
  misses: number
  hit_rate: number
  bytes: number
  evictions: number
}

export interface ClearCacheResponse {
  cleared: number
}

export interface HealthCheckResult {
  name: string
  ok: boolean
  latency_ms: number | null
  status: number | null
}

export interface HealthCheckResponse {
  results: HealthCheckResult[]
}

export interface ProbeResponse {
  probed?: number
  status?: string
  [key: string]: unknown
}
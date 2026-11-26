export type HostName = 'sprite' | 'e2b';
export type MachineKind = 'project' | 'mcp';
export type Machine = { host: HostName; name: string; url: string; token: string | null };
export type ServiceSpec = { name: string; cmd: string; args: string[]; httpPort?: number };
export type Liveness = 'running' | 'paused' | 'gone';

export interface RuntimeHost {
  readonly name: HostName;
  /** claim：固定名稱（spriteName／hostedSpriteName）。Sprite 用它當名稱；E2B 寫進 metadata.claim */
  create(claim: string, kind: MachineKind): Promise<Machine>;
  /** name 可以是機器名稱或 claim；已不在算成功；只刪本平台、前綴相符的 */
  destroy(name: string, prefix: 'agenthub-' | 'agenthub-mcp-'): Promise<void>;
  /** 以 runtime 帳號（Sprite: sprite；E2B: user）跑 bash -lc，回傳 stdout；非 0 結束丟錯。timeoutMs 未給時用各家 SDK 的預設 */
  exec(m: Machine, script: string, opts?: { timeoutMs?: number }): Promise<string>;
  writeFile(m: Machine, path: string, content: string): Promise<void>;
  /** 建立或取代並（重新）啟動 */
  startService(m: Machine, spec: ServiceSpec): Promise<void>;
  hasService(m: Machine, name: string): Promise<boolean>;
  restartService(m: Machine, name: string): Promise<void>;
  serviceLog(m: Machine, name: string, lines: number): Promise<string>;
  /** 延長存活；Sprite 不需要，回 'running' */
  extend(m: Machine, ms: number): Promise<Liveness>;
  status(m: Machine): Promise<Liveness>;
  edgeHeaders(m: Machine): Record<string, string>;
}

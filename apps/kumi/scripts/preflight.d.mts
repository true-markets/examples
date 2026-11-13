export interface Check {
  ok: boolean;
  label: string;
  fix: string | null;
}

export function isPortFree(port: number): Promise<boolean>;

export function runChecks(options?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  nodeVersion?: string;
  portFree?: (port: number) => Promise<boolean>;
}): Promise<Check[]>;

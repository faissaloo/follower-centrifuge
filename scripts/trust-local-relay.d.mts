/** Type declarations for scripts/trust-local-relay.mjs. */
export interface FirefoxTrustProfileResult {
  readonly profileDir: string;
  readonly mode?: 'ca' | 'override' | 'skipped' | 'failed';
  readonly changed?: boolean;
  readonly backupPath?: string | null;
  readonly error?: string;
}

export interface FirefoxTrustResult {
  readonly ok: boolean;
  readonly mode?: 'ca' | 'override';
  readonly reason?: string;
  readonly caFingerprint?: string;
  readonly leafFingerprint?: string;
  readonly certutil?: string;
  readonly profiles?: FirefoxTrustProfileResult[];
  readonly restartRequired?: boolean;
}

export interface RelayTrustOptions {
  readonly rootDir?: string;
  readonly home?: string;
  readonly wssPort?: number;
  readonly allowDownloadCertutil?: boolean;
  readonly certutilPath?: string | null;
}

export const CA_NICKNAME: string;
export function certificateFingerprintSha256(certPem: string): string;
export function overrideLine(wssPort: number, fingerprint: string): string;
export function findCertutil(rootDir?: string): string | null;
export function ensureCertutil(rootDir?: string, options?: { readonly allowDownload?: boolean }): string | null;
export function findFirefoxProfiles(home?: string): string[];
export function findChromeNssDb(home?: string): string | null;
export function installOverrideInProfile(
  profileDir: string,
  line: string,
  wssPort?: number,
): { readonly changed: boolean; readonly backupPath: string | null };
export function removeOverrideFromProfile(
  profileDir: string,
  wssPort?: number,
): { readonly changed: boolean };
export function installRelayTrust(options?: RelayTrustOptions): FirefoxTrustResult;
export function installFirefoxRelayTrust(options?: RelayTrustOptions): FirefoxTrustResult;

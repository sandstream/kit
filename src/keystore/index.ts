/**
 * Barrel for the KeyStore port (Pillar 1). Callers import from
 * "./keystore/index.js" — one public path for the whole pillar.
 */
export type { KeyStore, KeyStoreKind, KeyStoreAvailability, KeyStoreResolution } from "./types.js";
export { FileKeyStore } from "./file-store.js";
export { ExternalCommandKeyStore } from "./command-store.js";
export { SecureEnclaveKeyStore } from "./secure-enclave-store.js";
export { TpmKeyStore } from "./tpm-store.js";
export { resolveKeyStore } from "./resolve.js";
export {
  isHardwareRooted,
  hardwareRequiredByEnv,
  policyRequiresHardware,
  hardwareRequired,
  assertHardwareIdentity,
  keystoreSign,
  activeKeyStoreStatus,
  type KeyStoreStatus,
} from "./active.js";
export { keystoreRecordRevocation } from "./revoke.js";

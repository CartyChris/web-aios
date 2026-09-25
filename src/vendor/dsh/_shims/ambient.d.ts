/**
 * Web-AIOS shim (NOT upstream code). Vendored files keep their upstream
 * `declare module '@deepseek-ai/cordis' { interface Events {...} }` augmentations
 * verbatim; TypeScript requires the augmented module to exist, so these empty
 * ambient modules give them something to merge into. Nothing here runs.
 */
declare module '@deepseek-ai/cordis' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Events {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Context {}
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface SessionProjectionMap {}
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface RemoteErrorDetailsMap {}
}

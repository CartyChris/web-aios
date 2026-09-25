/**
 * Web-AIOS shim (NOT upstream code). Stands in for `@deepseek-ai/dsh-attachment`'s
 * package entry, whose index.ts also defines a Cordis `Service` (AttachmentStore) and
 * node:buffer admission. Re-exports only the vendored framework-free files.
 */
export { AttachmentId, ImageVariantId } from '../packages/attachment/attachment/src/brand.ts'
export { AttachmentError, isAttachmentError, isImageAdmissionError } from '../packages/attachment/attachment/src/error.ts'
export type { AttachmentErrorCode, ImageAdmissionErrorCode } from '../packages/attachment/attachment/src/error.ts'
export { longEdgeDimensions, requestImageDimensions } from '../packages/attachment/attachment/src/request-projection.ts'
export type { ProjectedDimensions } from '../packages/attachment/attachment/src/request-projection.ts'
export type * from '../packages/attachment/attachment/src/types.ts'

import type { ImageAttachmentRef } from '../packages/attachment/attachment/src/types.ts'
/**
 * Upstream `AttachmentStore` is an abstract Cordis `Service`. The vendored content.ts
 * uses it only as a type and calls exactly one member, so this is that member's
 * structural contract. Web-AIOS has no attachment host path, so implementations return
 * undefined, which is also what the upstream base class returns.
 */
export interface AttachmentStore {
  imageHostPath(ref: ImageAttachmentRef): string | undefined
}

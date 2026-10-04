import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { CardNoteDatabase } from './database.ts';

/**
 * 附件文件级操作（迁移自 card_note `lib/features/attachments/data/attachment_repository.dart`）。
 * 内容寻址存储：文件以 SHA-256 命名放在模块数据目录的 media/ 下，数据库不存 Base64
 * 与本机原始路径；行级写入/outbox 在 CardNoteDatabase。校验规则见迁移设计文档 §5.1 V5。
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** 与源 _mimeTypeFor 一致：仅 PNG/JPEG/WebP。 */
function mimeTypeFor(extension: string): string | null {
  switch (extension.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

function canonicalExtension(extension: string): string {
  return extension.toLowerCase() === '.jpeg' ? '.jpg' : extension.toLowerCase();
}

export interface ProbeImageResult {
  readonly ok: boolean;
  readonly originalFileName: string;
  readonly byteSize: number;
  readonly previewDataUrl: string | null;
  readonly error: string | null;
}

/**
 * 选图草稿的预检（对应源 _pickAttachments 中的大小/类型过滤）：
 * 返回文件名、大小与缩略用 data URL；不落库。
 */
export function probeImage(sourcePath: string): ProbeImageResult {
  const originalFileName = basename(sourcePath);
  try {
    const stat = statSync(sourcePath);
    if (stat.size <= 0) {
      return {
        ok: false,
        originalFileName,
        byteSize: 0,
        previewDataUrl: null,
        error: '不能添加空图片文件',
      };
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        originalFileName,
        byteSize: stat.size,
        previewDataUrl: null,
        error: `${originalFileName} 超过 10 MB，已跳过`,
      };
    }
    const extension = extname(originalFileName);
    if (mimeTypeFor(extension) === null) {
      return {
        ok: false,
        originalFileName,
        byteSize: stat.size,
        previewDataUrl: null,
        error: '仅支持 PNG、JPEG 和 WebP 图片',
      };
    }
    const dataUrl = `data:${mimeTypeFor(extension)};base64,${readFileSync(sourcePath).toString('base64')}`;
    return {
      ok: true,
      originalFileName,
      byteSize: stat.size,
      previewDataUrl: dataUrl,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      originalFileName,
      byteSize: 0,
      previewDataUrl: null,
      error:
        error instanceof Error && error.message.includes('ENOENT')
          ? '所选图片不存在或已被移动'
          : String(error),
    };
  }
}

export class AttachmentStore {
  readonly #repository: CardNoteDatabase;
  readonly #mediaDirectory: string;

  constructor(repository: CardNoteDatabase, dataDir: string) {
    this.#repository = repository;
    this.#mediaDirectory = join(dataDir, 'media');
  }

  /** 校验并落盘（SHA-256 命名、tmp+rename 原子写），随后写行与 outbox（源 addFromPath）。 */
  addFromPath(input: {
    id: string;
    noteId: string;
    sourcePath: string;
    originalFileName: string;
    sortOrder: number;
  }): void {
    let stat;
    try {
      stat = statSync(input.sourcePath);
    } catch {
      throw new Error('所选图片不存在或已被移动');
    }
    if (stat.size <= 0) throw new Error('不能添加空图片文件');
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error('单张图片不能超过 10 MB');
    const extension = extname(input.originalFileName).toLowerCase();
    const mimeType = mimeTypeFor(extension);
    if (mimeType === null) throw new Error('仅支持 PNG、JPEG 和 WebP 图片');

    const contentHash = createHash('sha256').update(readFileSync(input.sourcePath)).digest('hex');
    const storedFileName = `${contentHash}${canonicalExtension(extension)}`;
    mkdirSync(this.#mediaDirectory, { recursive: true });
    const destination = join(this.#mediaDirectory, storedFileName);
    if (!existsSync(destination)) {
      const temporary = `${destination}.tmp-${input.id}`;
      copyFileSync(input.sourcePath, temporary);
      try {
        renameSync(temporary, destination);
      } catch {
        // 并发下另一写入已完成时保留既有文件。
        if (existsSync(destination)) unlinkSync(temporary);
        else throw new Error('附件写入失败');
      }
    }

    this.#repository.upsertAttachment({
      id: input.id,
      noteId: input.noteId,
      storedFileName,
      originalFileName: input.originalFileName,
      mimeType,
      byteSize: stat.size,
      sortOrder: input.sortOrder,
      contentHash,
    });
  }

  remove(attachmentId: string): void {
    this.#repository.deleteAttachment(attachmentId);
  }

  /**
   * 同步导入路径（源 importSynced）：远端工作区附件落库前的强校验——
   * 文件名 = basename 且以 contentHash 开头、MIME 与扩展名匹配、大小 ≤10MB、
   * 实际字节数与 SHA-256 均匹配；通过后复制入 media/ 并直接写行（不产生 outbox）。
   */
  importSynced(input: {
    id: string;
    noteId: string;
    storedFileName: string;
    originalFileName: string;
    mimeType: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    sortOrder: number;
    contentHash: string;
    createdAt: number;
    updatedAt: number;
    sourcePath: string;
  }): void {
    if (
      basename(input.storedFileName) !== input.storedFileName ||
      !input.storedFileName.startsWith(input.contentHash)
    ) {
      throw new Error('附件资源文件名无效');
    }
    if (mimeTypeFor(extname(input.storedFileName).toLowerCase()) !== input.mimeType) {
      throw new Error('附件资源类型不匹配');
    }
    if (input.byteSize <= 0 || input.byteSize > MAX_ATTACHMENT_BYTES) {
      throw new Error('附件资源大小超出限制');
    }
    if (!existsSync(input.sourcePath)) throw new Error('附件资源文件缺失');
    if (statSync(input.sourcePath).size !== input.byteSize) {
      throw new Error('附件资源大小不匹配');
    }
    const digest = createHash('sha256').update(readFileSync(input.sourcePath)).digest('hex');
    if (digest !== input.contentHash) {
      throw new Error('附件资源校验失败');
    }
    mkdirSync(this.#mediaDirectory, { recursive: true });
    const destination = join(this.#mediaDirectory, input.storedFileName);
    if (!existsSync(destination)) copyFileSync(input.sourcePath, destination);
    this.#repository.upsertAttachmentRow({
      id: input.id,
      noteId: input.noteId,
      storedFileName: input.storedFileName,
      originalFileName: input.originalFileName,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      sortOrder: input.sortOrder,
      contentHash: input.contentHash,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
  }

  reorder(ids: readonly string[]): void {
    this.#repository.reorderAttachments(ids);
  }

  /** 读取为 data URL（渲染端缩略图用；替代源直接引用本地路径的方式）。 */
  readAsDataUrl(attachment: { storedFileName: string; mimeType: string }): string {
    const safeName = basename(attachment.storedFileName);
    const path = join(this.#mediaDirectory, safeName);
    return `data:${attachment.mimeType};base64,${readFileSync(path).toString('base64')}`;
  }
}

export function newAttachmentId(): string {
  return randomUUID();
}

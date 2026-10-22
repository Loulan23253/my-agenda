import { TFile, TFolder, normalizePath, Vault, FileManager } from "obsidian";
import type { KeyValueFileIO } from "../data/io";

/** Obsidian vault 实现:兼容索引滞后(用 adapter 兜底)。 */
export class VaultFileIO implements KeyValueFileIO {
  constructor(
    private readonly vault: Vault,
    private readonly fileManager: FileManager,
  ) {}

  async readText(path: string): Promise<string | null> {
    const p = normalizePath(path);
    const f = this.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) return this.vault.read(f);
    if (await this.vault.adapter.exists(p)) return this.vault.adapter.read(p);
    return null;
  }

  async writeText(path: string, content: string): Promise<void> {
    const p = normalizePath(path);
    const f = this.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) {
      await this.vault.process(f, () => content);
      return;
    }
    await this.ensureDir(p.slice(0, Math.max(0, p.lastIndexOf("/"))));
    try {
      await this.vault.create(p, content);
    } catch {
      await this.vault.adapter.write(p, content);
    }
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    const f = this.vault.getAbstractFileByPath(p);
    // trashFile 尊重用户的删除偏好(系统回收站/库内 .trash)
    if (f instanceof TFile) await this.fileManager.trashFile(f);
    else if (await this.vault.adapter.exists(p)) await this.vault.adapter.remove(p);
  }

  async listFiles(dir: string): Promise<string[]> {
    const p = normalizePath(dir);
    const f = this.vault.getAbstractFileByPath(p);
    if (f instanceof TFolder) return f.children.filter((c): c is TFile => c instanceof TFile).map((c) => c.path);
    // iCloud 下载/移动后索引可能滞后，不能把尚未索引的目录当作空目录。
    if (!(await this.vault.adapter.exists(p))) return [];
    return (await this.vault.adapter.list(p)).files;
  }

  async ensureDir(dir: string): Promise<void> {
    const p = normalizePath(dir);
    if (!p || this.vault.getAbstractFileByPath(p) instanceof TFolder) return;
    await this.vault.createFolder(p).catch(() => {});
  }
}

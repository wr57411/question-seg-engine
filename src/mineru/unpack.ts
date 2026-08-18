/**
 * unpack.ts —— 结果 Zip 解包：提取 *_content_list.json / full.md / images/。
 *
 * 文件名匹配容错（前缀随文档名变化），只认后缀；zip 条目结构以
 * docs/real-api-notes.md §4 实测为准（<taskId>_content_list.json / full.md / images/）。
 */
import AdmZip from "adm-zip";

export interface UnpackedResult {
  contentList: unknown;
  markdown: string;
  /** images/ 目录下的图片（含路径，供 ImageRef.path 挂回题目） */
  images: { path: string; data: Buffer }[];
}

export function unpackResult(zipBuffer: Buffer): UnpackedResult {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const name = (e: (typeof entries)[number]) => e.entryName;

  const contentEntry = entries.find((e) => name(e).endsWith("content_list.json"));
  if (!contentEntry) throw new Error("Zip 中未找到 *_content_list.json");
  const contentList: unknown = JSON.parse(contentEntry.getData().toString("utf8"));

  const mdEntry = entries.find(
    (e) => name(e).toLowerCase().endsWith("full.md") || name(e).endsWith(".md"),
  );
  const markdown = mdEntry ? mdEntry.getData().toString("utf8") : "";

  const images = entries
    .filter((e) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(name(e)))
    .map((e) => ({ path: name(e), data: e.getData() }));

  return { contentList, markdown, images };
}
import { auth } from "@/auth";
import { DRIVE_FALLBACK_FOLDER_ID } from "@/lib/jsonCanonSources";

export interface SavedSummaryRecord {
  fileId: string;
  fileName: string;
  setName: string;
  date: string;
  issuerName: string;
  docType: string;
  action: string;
  summaryBody: string;
  summaryText: string;
  createdTime?: string;
  modifiedTime?: string;
}

interface DriveFileItem {
  id: string;
  name: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
}

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const SUMMARY_FILE_PATTERN = /\.md$/i;
const MAX_HISTORY_FILES = 200;

const normalizeComparable = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();

const extractSummaryField = (summary: string, label: string) =>
  summary.match(new RegExp(`^${label}\\s*[:：]\\s*(.+)$`, "imu"))?.[1]?.trim() || "";

const extractSummaryMarkdown = (markdown: string) => {
  const match = markdown.match(/##\s+summary\s*\n+([\s\S]*?)(?:\n+---\s*\n|$)/i);
  return match?.[1]?.trim() || markdown.trim();
};

const extractDateFromName = (name: string) => {
  const match = name.match(/(20\d{2})(\d{2})(\d{2})(?!\d)/);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}`;
};

const getAccessToken = async () => {
  const session = await auth();
  const accessToken = (session as any)?.accessToken as string | undefined;
  if (!accessToken) {
    throw new Error("Missing Google Drive access token on session.");
  }
  return accessToken;
};

const listDriveChildren = async (folderId: string, accessToken: string) => {
  const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,createdTime,modifiedTime)&orderBy=modifiedTime desc&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to list Drive children: ${response.status} ${text}`);
  }

  const json = (await response.json().catch(() => null)) as { files?: DriveFileItem[] } | null;
  return json?.files ?? [];
};

const downloadTextFile = async (fileId: string, accessToken: string) => {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to download summary file: ${response.status} ${text}`);
  }

  return response.text();
};

const collectSummaryFiles = async (
  folderId: string,
  accessToken: string,
  depth = 0,
): Promise<DriveFileItem[]> => {
  if (depth > 4) return [];

  const children = await listDriveChildren(folderId, accessToken);
  const markdownFiles = children.filter((item) => SUMMARY_FILE_PATTERN.test(item.name));
  const folders = children.filter((item) => item.mimeType === DRIVE_FOLDER_MIME);

  const nestedFiles = await Promise.all(
    folders.map((folder) => collectSummaryFiles(folder.id, accessToken, depth + 1)),
  );

  return [...markdownFiles, ...nestedFiles.flat()].slice(0, MAX_HISTORY_FILES);
};

const parseSavedSummary = async (file: DriveFileItem, accessToken: string): Promise<SavedSummaryRecord | null> => {
  const markdown = await downloadTextFile(file.id, accessToken);
  const summaryText = extractSummaryMarkdown(markdown);
  if (!summaryText) return null;

  const setName = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || file.name.replace(/\.md$/i, "");
  const date = extractDateFromName(setName) || file.modifiedTime?.slice(0, 10) || file.createdTime?.slice(0, 10) || "";

  return {
    fileId: file.id,
    fileName: file.name,
    setName,
    date,
    issuerName: extractSummaryField(summaryText, "單位"),
    docType: extractSummaryField(summaryText, "類型"),
    action: extractSummaryField(summaryText, "行動"),
    summaryBody: extractSummaryField(summaryText, "摘要內容"),
    summaryText,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
  };
};

const rankHistoryBySimilarity = (editableSummary: string, history: SavedSummaryRecord[]) => {
  const normalizedSummary = normalizeComparable(editableSummary);
  const issuer = extractSummaryField(editableSummary, "單位");
  const docType = extractSummaryField(editableSummary, "類型");
  const action = extractSummaryField(editableSummary, "行動");
  const summaryBody = extractSummaryField(editableSummary, "摘要內容");
  const bodyTokens = Array.from(new Set(summaryBody.split(/\s+/).map((token) => token.trim()).filter((token) => token.length >= 2)));

  return history
    .map((item) => {
      let score = 0;
      if (issuer && normalizeComparable(item.issuerName) === normalizeComparable(issuer)) score += 80;
      if (docType && item.docType === docType) score += 20;
      if (action && item.action === action) score += 12;
      if (normalizedSummary.includes(normalizeComparable(item.issuerName)) && item.issuerName) score += 12;
      for (const token of bodyTokens) {
        if (item.summaryText.includes(token)) score += 2;
      }
      return { item, score };
    })
    .sort((left, right) => right.score - left.score)
    .map(({ item }) => item);
};

export const loadSavedSummaryHistory = async (): Promise<SavedSummaryRecord[]> => {
  const rootFolderId = process.env.DRIVE_FOLDER_ID || DRIVE_FALLBACK_FOLDER_ID;
  if (!rootFolderId) return [];

  const accessToken = await getAccessToken();
  const files = await collectSummaryFiles(rootFolderId, accessToken);
  const records = await Promise.all(files.map((file) => parseSavedSummary(file, accessToken)));

  return records.filter((record): record is SavedSummaryRecord => Boolean(record));
};

export const buildHistoryContext = (editableSummary: string, history: SavedSummaryRecord[], limit = 20) =>
  rankHistoryBySimilarity(editableSummary, history)
    .slice(0, limit)
    .map(
      (item, index) =>
        [
          `歷史文件 ${index + 1}`,
          `文件名：${item.setName}`,
          `日期：${item.date || "未知"}`,
          `寄件單位：${item.issuerName || ""}`,
          `類型：${item.docType || ""}`,
          `行動：${item.action || ""}`,
          `摘要：${item.summaryBody || item.summaryText}`,
        ].join("\n"),
    )
    .join("\n\n");

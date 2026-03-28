import { createHash } from "crypto";
import { auth } from "@/auth";
import { GPT_Router } from "@/lib/gptRouter";
import { DRIVE_ACTIVE_SUBFOLDER_SOURCE } from "@/lib/jsonCanonSources";
import {
  embedTextWithOpenAI,
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_MODEL,
} from "@/lib/openaiEmbeddings";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const QDRANT_URL =
  process.env.QDRANT_URL ||
  "https://09d1087a-9021-40cf-a060-5c3d33f14a8c.us-west-1-0.aws.cloud.qdrant.io:6333";
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION_NAME || "documents";
const BASE_DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";

interface ActiveSubfolder {
  topic: string;
  folderId?: string;
}

interface DriveFileRow {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
}

const toStablePointId = (value: string) => {
  const hash = createHash("sha256").update(value).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
};

const flattenStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const collectEntityTerms = (entities: unknown) => {
  if (!entities || typeof entities !== "object") return [] as string[];

  const typed = entities as Record<string, unknown>;
  return [
    ...flattenStringArray(typed.persons),
    ...flattenStringArray(typed.orgs),
    ...flattenStringArray(typed.accounts),
    ...flattenStringArray(typed.addresses),
    ...flattenStringArray(typed.phones),
  ];
};

const collectPageText = (pages: unknown) => {
  if (!Array.isArray(pages)) return [] as string[];

  return pages.flatMap((page) => {
    if (!page || typeof page !== "object") return [];

    const typed = page as Record<string, unknown>;
    const sections = Array.isArray(typed.sections)
      ? typed.sections
          .flatMap((section) => {
            if (!section || typeof section !== "object") return [];
            const typedSection = section as Record<string, unknown>;
            return [typedSection.section_title, typedSection.content]
              .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
          })
      : [];

    return [typed.text, ...sections].filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
  });
};

const buildFolderPath = (slugOrPath: string, base: string) => {
  if (!slugOrPath) return base;
  if (slugOrPath.startsWith(`${base}/`) || slugOrPath === base) return slugOrPath;
  if (slugOrPath.includes("/")) return slugOrPath;
  return `${base}/${slugOrPath}`;
};

const normalizeSubfolderConfig = (config: unknown): ActiveSubfolder[] => {
  if (!config) return [];
  if (Array.isArray(config)) return config as ActiveSubfolder[];
  const typed = config as { subfolders?: ActiveSubfolder[] };
  return Array.isArray(typed?.subfolders) ? typed.subfolders : [];
};

const getAccessToken = async () => {
  const session = await auth();
  if (!session) throw new Error("Not authenticated.");
  const accessToken = (session as any)?.accessToken as string | undefined;
  if (!accessToken) throw new Error("Missing Google Drive access token on session.");
  return accessToken;
};

const listFolderEntries = async (folderId: string, accessToken: string) => {
  const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,parents)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to list Drive folder '${folderId}': ${response.status} ${text}`);
  }

  const json = (await response.json().catch(() => null)) as { files?: DriveFileRow[] } | null;
  return json?.files ?? [];
};

const downloadDriveTextFile = async (fileId: string, accessToken: string) => {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to download Drive file '${fileId}': ${response.status} ${text}`);
  }

  return response.text();
};

const resolveFolderIdFromPath = async (folderPath: string, accessToken: string) => {
  const parts = folderPath.split("/").filter(Boolean);
  if (!parts.length) throw new Error("Malformed Drive folder path");

  let currentId = parts.shift()!;
  for (const segment of parts) {
    const query = encodeURIComponent(
      `name = '${segment.replace(/'/g, "\\'")}' and '${currentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    );
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Failed to resolve Drive folder '${segment}': ${response.status} ${text}`);
    }

    const json = (await response.json().catch(() => null)) as
      | { files?: Array<{ id: string; name: string }> }
      | null;
    const nextId = json?.files?.[0]?.id;
    if (!nextId) {
      throw new Error(`Drive subfolder '${segment}' not found under '${currentId}'`);
    }
    currentId = nextId;
  }

  return currentId;
};

const collectJsonFilesRecursively = async (
  rootFolderId: string,
  accessToken: string,
  pathLabel: string,
): Promise<Array<DriveFileRow & { drivePath: string }>> => {
  const queue: Array<{ id: string; pathLabel: string }> = [{ id: rootFolderId, pathLabel }];
  const results: Array<DriveFileRow & { drivePath: string }> = [];

  while (queue.length) {
    const current = queue.shift()!;
    const entries = await listFolderEntries(current.id, accessToken);

    for (const entry of entries) {
      if (entry.mimeType === "application/vnd.google-apps.folder") {
        queue.push({
          id: entry.id,
          pathLabel: `${current.pathLabel}/${entry.name}`,
        });
        continue;
      }

      if (/\.json$/i.test(entry.name)) {
        results.push({
          ...entry,
          drivePath: `${current.pathLabel}/${entry.name}`,
        });
      }
    }
  }

  return results;
};

const ensureQdrantCollection = async () => {
  const response = await fetch(
    `${QDRANT_URL.replace(/\/+$/, "")}/collections/${encodeURIComponent(QDRANT_COLLECTION)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.QDRANT_API_KEY ? { "api-key": process.env.QDRANT_API_KEY } : {}),
      },
      body: JSON.stringify({
        vectors: {
          size: OPENAI_EMBEDDING_DIMENSIONS,
          distance: "Cosine",
        },
      }),
      cache: "no-store",
    },
  );

  if (response.status === 409) {
    const inspectResponse = await fetch(
      `${QDRANT_URL.replace(/\/+$/, "")}/collections/${encodeURIComponent(QDRANT_COLLECTION)}`,
      {
        headers: {
          ...(process.env.QDRANT_API_KEY ? { "api-key": process.env.QDRANT_API_KEY } : {}),
        },
        cache: "no-store",
      },
    );

    if (!inspectResponse.ok) {
      const text = await inspectResponse.text().catch(() => "");
      throw new Error(
        `Failed to inspect existing Qdrant collection '${QDRANT_COLLECTION}': ${inspectResponse.status} ${text}`,
      );
    }

    const inspectJson = (await inspectResponse.json().catch(() => null)) as
      | { result?: { config?: { params?: { vectors?: { size?: number } } } } }
      | null;
    const existingSize = inspectJson?.result?.config?.params?.vectors?.size;

    if (existingSize && existingSize !== OPENAI_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Qdrant collection '${QDRANT_COLLECTION}' already exists with vector size ${existingSize}, but ${OPENAI_EMBEDDING_MODEL} expects ${OPENAI_EMBEDDING_DIMENSIONS}. Rebuild the collection or use a new QDRANT_COLLECTION_NAME.`,
      );
    }

    console.log("/api/generate-rag-context collection already exists, continuing:", {
      collection: QDRANT_COLLECTION,
      existingVectorSize: existingSize || OPENAI_EMBEDDING_DIMENSIONS,
      embeddingModel: OPENAI_EMBEDDING_MODEL,
    });
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to ensure Qdrant collection: ${response.status} ${text}`);
  }
};

const buildIndexText = (doc: Record<string, any>, fileName: string, drivePath: string, topic: string) => {
  const incidentKeys = flattenStringArray(doc.incident_keys);
  const entityTerms = collectEntityTerms(doc.entities);
  const pageTerms = collectPageText(doc.pages);

  return [
    topic,
    drivePath,
    fileName,
    doc.file_group_id || "",
    doc.issuer_name || "",
    doc.issuer_alias || "",
    doc.subject_category || "",
    doc.doc_class || "",
    doc.actionable_in_verb || "",
    doc.doc_date || "",
    doc.title || "",
    doc.summary || "",
    incidentKeys.join(" "),
    entityTerms.join(" "),
    pageTerms.join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
};

const approximateTokenCount = (text: string) => Math.max(1, Math.round(text.length / 4));

const upsertQdrantPoints = async (points: Array<Record<string, any>>) => {
  const response = await fetch(
    `${QDRANT_URL.replace(/\/+$/, "")}/collections/${encodeURIComponent(QDRANT_COLLECTION)}/points?wait=true`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.QDRANT_API_KEY ? { "api-key": process.env.QDRANT_API_KEY } : {}),
      },
      body: JSON.stringify({ points }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to upsert Qdrant points: ${response.status} ${text}`);
  }
};

export async function POST() {
  try {
    if (!BASE_DRIVE_FOLDER_ID) {
      return NextResponse.json({ ok: false, error: "Missing DRIVE_FOLDER_ID" }, { status: 500 });
    }

    const accessToken = await getAccessToken();
    const config = await GPT_Router.fetchJsonSource(DRIVE_ACTIVE_SUBFOLDER_SOURCE);
    const subfolders = normalizeSubfolderConfig(config);

    if (!subfolders.length) {
      return NextResponse.json(
        { ok: false, error: "No active Drive subfolders configured." },
        { status: 400 },
      );
    }

    await ensureQdrantCollection();

    const indexedFolders: Array<{ topic: string; fileCount: number }> = [];
    const skippedFiles: Array<{ path: string; reason: string }> = [];
    let indexedCount = 0;
    let totalIndexedChars = 0;
    let totalIndexedTokens = 0;

    for (const subfolder of subfolders) {
      const folderPath = buildFolderPath(subfolder.folderId || subfolder.topic, BASE_DRIVE_FOLDER_ID);
      const resolvedFolderId = await resolveFolderIdFromPath(folderPath, accessToken);
      const jsonFiles = await collectJsonFilesRecursively(
        resolvedFolderId,
        accessToken,
        subfolder.topic,
      );

      indexedFolders.push({ topic: subfolder.topic, fileCount: jsonFiles.length });

      for (const file of jsonFiles) {
        try {
          const raw = await downloadDriveTextFile(file.id, accessToken);
          const doc = JSON.parse(raw) as Record<string, any>;
          const indexText = buildIndexText(doc, file.name, file.drivePath, subfolder.topic);
          const approxTokens = approximateTokenCount(indexText);
          const vector = await embedTextWithOpenAI(indexText);

          await upsertQdrantPoints([
            {
              id: toStablePointId(file.id),
              vector,
              payload: {
                drive_file_id: file.id,
                drive_path: file.drivePath,
                topic: subfolder.topic,
                file_name: file.name,
                issuer_name: doc.issuer_name || "",
                issuer_alias: doc.issuer_alias || "",
                subject_category: doc.subject_category || "",
                doc_class: doc.doc_class || "",
                actionable_in_verb: doc.actionable_in_verb || "",
                doc_date: doc.doc_date || "",
                title: doc.title || "",
                summary: doc.summary || "",
                incident_keys: flattenStringArray(doc.incident_keys),
                entities: doc.entities && typeof doc.entities === "object" ? doc.entities : {},
                entity_terms: collectEntityTerms(doc.entities),
                pages_text: collectPageText(doc.pages),
                file_group_id: doc.file_group_id || "",
              },
            },
          ]);

          indexedCount += 1;
          totalIndexedChars += indexText.length;
          totalIndexedTokens += approxTokens;
          console.log("/api/generate-rag-context Qdrant upsert:", {
            topic: subfolder.topic,
            drivePath: file.drivePath,
            fileId: file.id,
            vectorSize: vector.length,
            indexedChars: indexText.length,
            approxIndexedTokens: approxTokens,
            embeddingModel: OPENAI_EMBEDDING_MODEL,
            payloadKeys: [
              "drive_file_id",
              "drive_path",
              "topic",
              "file_name",
              "issuer_name",
              "issuer_alias",
              "subject_category",
              "doc_class",
              "actionable_in_verb",
              "doc_date",
              "title",
              "summary",
              "incident_keys",
              "entities",
              "entity_terms",
              "pages_text",
              "file_group_id",
            ],
          });
        } catch (error: any) {
          skippedFiles.push({
            path: file.drivePath,
            reason: error?.message || "Unknown indexing error",
          });
        }
      }
    }

    console.log("/api/generate-rag-context indexing summary:", {
      indexedCount,
      skippedCount: skippedFiles.length,
      totalIndexedChars,
      totalIndexedTokens,
      averageIndexedTokensPerFile: indexedCount ? Math.round(totalIndexedTokens / indexedCount) : 0,
      qdrantCollection: QDRANT_COLLECTION,
      qdrantVectorSize: OPENAI_EMBEDDING_DIMENSIONS,
      embeddingModel: OPENAI_EMBEDDING_MODEL,
      indexedFolders,
      skippedFiles,
    });

    return NextResponse.json({
      ok: true,
      collection: QDRANT_COLLECTION,
      indexedCount,
      skippedCount: skippedFiles.length,
      totalIndexedChars,
      totalIndexedTokens,
      averageIndexedTokensPerFile: indexedCount ? Math.round(totalIndexedTokens / indexedCount) : 0,
      qdrantVectorSize: OPENAI_EMBEDDING_DIMENSIONS,
      embeddingModel: OPENAI_EMBEDDING_MODEL,
      indexedFolders,
      skippedFiles,
    });
  } catch (error: any) {
    console.error("/api/generate-rag-context failed:", error);
    return NextResponse.json(
      { ok: false, error: error?.message || "Unknown generate-rag-context error" },
      { status: 500 },
    );
  }
}

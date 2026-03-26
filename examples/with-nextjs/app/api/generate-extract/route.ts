import { Buffer } from "buffer";

import { NextResponse } from "next/server";

import { driveSaveFiles } from "@/lib/driveSaveFiles";
import { GPT_Router } from "@/lib/gptRouter";
import {
  DRIVE_ACTIVE_SUBFOLDER_SOURCE,
  ONE_SHOT_EXAMPLE_SOURCE,
  PROMPT_EXTRACT_SOURCE,
  SUBJECT_CAT_DOC_CLASS_ACTION_VERB_SOURCE,
} from "@/lib/jsonCanonSources";
import { normalizeFilename } from "@/lib/normalizeFilename";

export const runtime = "nodejs";

const QDRANT_URL =
  process.env.QDRANT_URL ||
  "https://09d1087a-9021-40cf-a060-5c3d33f14a8c.us-west-1-0.aws.cloud.qdrant.io:6333";
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION_NAME || "documents";
const QDRANT_VECTOR_SIZE = Number(process.env.QDRANT_VECTOR_SIZE || 384);
const FALLBACK_SUBFOLDER_TOPIC = "TaiwanPersonal";
const DEFAULT_IMAGE_MODEL = process.env.GENERATE_EXTRACT_MODEL || "minicpm-v";

interface RagCandidate {
  issuer_name: string;
  issuer_alias: string;
  subject_category: string;
  doc_class: string;
  actionable_in_verb: string;
  avg_score: number;
}

interface ActiveSubfolder {
  topic: string;
  folderId?: string;
}

const isImageUnsupportedError = (message: string) =>
  /image input is not supported|provide the mmproj/i.test(message);

const stripCodeFence = (text: string) =>
  text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

const yyyymmdd = (date: string) => (date || "").replace(/-/g, "");

const buildFileGroupId = (doc: Record<string, any>) =>
  [
    doc.issuer_name || "",
    doc.doc_class || "",
    doc.actionable_in_verb || "",
    yyyymmdd(doc.doc_date || ""),
  ]
    .filter(Boolean)
    .join("-");

const normalizeExtracted = (doc: Record<string, any>) => {
  const normalized = {
    ...doc,
    entities: doc.entities || {},
    incident_keys: Array.isArray(doc.incident_keys) ? doc.incident_keys : [],
    pages: Array.isArray(doc.pages) ? doc.pages : [],
    matched_incidents: Array.isArray(doc.matched_incidents) ? doc.matched_incidents : [],
    timeline: Array.isArray(doc.timeline) ? doc.timeline : [],
    action_plan: typeof doc.action_plan === "string" ? doc.action_plan : "",
  };

  if (!normalized.file_group_id) {
    normalized.file_group_id = buildFileGroupId(normalized);
  }

  return normalized;
};

const embedText = async (text: string) => {
  const vector = new Array(QDRANT_VECTOR_SIZE).fill(0);
  for (let index = 0; index < text.length; index += 1) {
    vector[index % QDRANT_VECTOR_SIZE] += text.charCodeAt(index) % 97;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
};

const buildQuery = ({
  filenameHint = "",
  hintText = "",
}: {
  filenameHint?: string;
  hintText?: string;
}) => [filenameHint, hintText].filter(Boolean).join("\n");

const groupRagCandidates = (results: Array<{ score?: number; payload?: Record<string, any> }>) => {
  const grouped = new Map<string, RagCandidate & { score: number; count: number }>();

  for (const hit of results) {
    const payload = hit.payload || {};
    if (!payload.issuer_name) continue;

    const key = [
      payload.issuer_name,
      payload.subject_category,
      payload.doc_class,
      payload.actionable_in_verb,
    ].join("|");

    if (!grouped.has(key)) {
      grouped.set(key, {
        issuer_name: payload.issuer_name,
        issuer_alias: payload.issuer_alias || "",
        subject_category: payload.subject_category || "",
        doc_class: payload.doc_class || "",
        actionable_in_verb: payload.actionable_in_verb || "",
        avg_score: 0,
        score: 0,
        count: 0,
      });
    }

    const row = grouped.get(key)!;
    row.score += hit.score || 0;
    row.count += 1;
  }

  return Array.from(grouped.values())
    .map((row) => ({
      issuer_name: row.issuer_name,
      issuer_alias: row.issuer_alias,
      subject_category: row.subject_category,
      doc_class: row.doc_class,
      actionable_in_verb: row.actionable_in_verb,
      avg_score: row.count ? row.score / row.count : 0,
    }))
    .sort((left, right) => right.avg_score - left.avg_score)
    .slice(0, 5);
};

const getRagContextWithFallback = async ({
  filenameHint,
  hintText,
}: {
  filenameHint?: string;
  hintText?: string;
}) => {
  const query = buildQuery({ filenameHint, hintText });

  if (!query) {
    return {
      rag: [] as RagCandidate[],
      rag_status: "skipped",
      rag_error: "",
    };
  }

  try {
    const vector = await embedText(query);
    const response = await fetch(
      `${QDRANT_URL.replace(/\/+$/, "")}/collections/${encodeURIComponent(QDRANT_COLLECTION)}/points/search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.QDRANT_API_KEY
            ? { "api-key": process.env.QDRANT_API_KEY }
            : {}),
        },
        body: JSON.stringify({
          vector,
          limit: 10,
          with_payload: true,
        }),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`Qdrant search failed (${response.status}): ${details || response.statusText}`);
    }

    const data = (await response.json().catch(() => null)) as
      | { result?: Array<{ score?: number; payload?: Record<string, any> }> }
      | null;

    const rag = groupRagCandidates(data?.result || []);
    return {
      rag,
      rag_status: rag.length ? "ok" : "empty",
      rag_error: "",
    };
  } catch (error: any) {
    console.error("Qdrant fallback triggered:", error);
    return {
      rag: [] as RagCandidate[],
      rag_status: "failed",
      rag_error: error?.message || "Qdrant search failed",
    };
  }
};

const buildPrompt = ({
  prompt,
  oneShot,
  rag,
  bible,
}: {
  prompt: Record<string, any>;
  oneShot: Record<string, any>;
  rag: RagCandidate[];
  bible: Record<string, any>;
}) => ({
  system: `${prompt.system}\n\n[terminology bible]\n${JSON.stringify(bible, null, 2)}`,
  user: `${prompt.instruction}

[RAG context]
${JSON.stringify(rag, null, 2)}

[one-shot example]
${JSON.stringify(oneShot, null, 2)}

[output schema]
${JSON.stringify(prompt.output_schema, null, 2)}`,
});

const buildImagePromptContent = (userPrompt: string, imageUrls: string[]) => [
  { type: "text" as const, text: userPrompt },
  ...imageUrls.map((url) => ({
    type: "image_url" as const,
    image_url: { url },
  })),
];

const callLlm = async ({
  images,
  system,
  user,
}: {
  images: string[];
  system: string;
  user: string;
}) => {
  const response = await fetch(GPT_Router.getChatEndpoint(), {
    method: "POST",
    headers: GPT_Router.getDefaultHeaders(),
    body: JSON.stringify({
      model: DEFAULT_IMAGE_MODEL,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: buildImagePromptContent(user, images),
        },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `generate-extract LLM failed (${response.status}): ${details || response.statusText}`,
    );
  }

  const data = (await response.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: string } }> }
    | null;
  return data?.choices?.[0]?.message?.content?.trim() || "";
};

const parseJsonBody = async (request: Request) => {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  return request.json().catch(() => null);
};

const parseFormBody = async (request: Request) => {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) return null;
  return request.formData().catch(() => null);
};

const resolveImages = async (request: Request) => {
  const clonedRequest = request.clone();
  const jsonBody = await parseJsonBody(request);

  if (jsonBody) {
    const images = Array.isArray(jsonBody.images)
      ? jsonBody.images.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];

    return {
      imageUrls: images,
      filenameHint: typeof jsonBody.filename_hint === "string" ? jsonBody.filename_hint : "",
      hintText: typeof jsonBody.hint_text === "string" ? jsonBody.hint_text : "",
    };
  }

  const formData = await parseFormBody(clonedRequest);
  if (!formData) {
    return { imageUrls: [], filenameHint: "", hintText: "" };
  }

  const imageFiles = [
    ...formData.getAll("image"),
    ...formData.getAll("images"),
    ...formData.getAll("files"),
  ].filter((value): value is File => value instanceof File);

  const uniqueImageFiles = imageFiles.filter(
    (file, index) => imageFiles.findIndex((entry) => entry === file) === index,
  );

  const imageUrls = await Promise.all(
    uniqueImageFiles.map(async (file) => {
      const buffer = Buffer.from(await file.arrayBuffer()).toString("base64");
      return `data:${file.type || "image/jpeg"};base64,${buffer}`;
    }),
  );

  return {
    imageUrls,
    filenameHint: String(formData.get("filename_hint") || ""),
    hintText: String(formData.get("hint_text") || ""),
  };
};

const resolveTaiwanPersonalFolder = async () => {
  const config = await GPT_Router.fetchJsonSource(DRIVE_ACTIVE_SUBFOLDER_SOURCE).catch(() => null);
  const subfolders = Array.isArray((config as { subfolders?: ActiveSubfolder[] } | null)?.subfolders)
    ? ((config as { subfolders?: ActiveSubfolder[] }).subfolders as ActiveSubfolder[])
    : Array.isArray(config)
      ? (config as ActiveSubfolder[])
      : [];

  const baseFolderId = process.env.DRIVE_FOLDER_ID;
  if (!baseFolderId) {
    throw new Error("Missing DRIVE_FOLDER_ID");
  }

  const selected = subfolders.find(
    (entry) => entry.topic.toLowerCase() === FALLBACK_SUBFOLDER_TOPIC.toLowerCase(),
  );

  const segment = selected?.folderId || selected?.topic || FALLBACK_SUBFOLDER_TOPIC;
  if (segment.startsWith(`${baseFolderId}/`) || segment === baseFolderId) {
    return segment;
  }

  if (segment.includes("/")) {
    return segment;
  }

  return `${baseFolderId}/${segment}`;
};

export async function POST(request: Request) {
  try {
    const { imageUrls, filenameHint, hintText } = await resolveImages(request);

    if (!imageUrls.length) {
      return NextResponse.json({ ok: false, error: "Missing images" }, { status: 400 });
    }

    const [prompt, oneShot, bible] = await Promise.all([
      GPT_Router.fetchJsonSource(PROMPT_EXTRACT_SOURCE),
      GPT_Router.fetchJsonSource(ONE_SHOT_EXAMPLE_SOURCE),
      GPT_Router.fetchJsonSource(SUBJECT_CAT_DOC_CLASS_ACTION_VERB_SOURCE),
    ]);

    const { rag, rag_status, rag_error } = await getRagContextWithFallback({
      filenameHint,
      hintText,
    });

    const { system, user } = buildPrompt({ prompt, oneShot, rag, bible });
    const raw = await callLlm({ images: imageUrls, system, user });
    const parsed = normalizeExtracted(JSON.parse(stripCodeFence(raw)));

    if (!parsed.file_group_id) {
      return NextResponse.json(
        { ok: false, error: "LLM output is missing file_group_id fields." },
        { status: 500 },
      );
    }

    const targetFolderId = await resolveTaiwanPersonalFolder();
    const fileName = normalizeFilename(`${parsed.file_group_id}.json`);
    const jsonPayload = JSON.stringify(parsed, null, 2);
    const uploadFile = new File([jsonPayload], fileName, { type: "application/json" });

    await driveSaveFiles({
      folderId: targetFolderId,
      files: [uploadFile],
      fileToUpload: async (file) => ({
        name: file.name,
        buffer: Buffer.from(await file.arrayBuffer()),
        mimeType: file.type || "application/json",
      }),
    });

    return NextResponse.json({
      ok: true,
      extracted: parsed,
      rag_used: rag,
      rag_status,
      rag_error,
      saved_file_name: fileName,
      targetFolderId,
    });
  } catch (error: any) {
    console.error("/api/generate-extract failed:", error);
    const message = error?.message || "Unknown generate-extract error";

    if (isImageUnsupportedError(message)) {
      return NextResponse.json(
        {
          ok: false,
          code: "LOCAL_LLM_IMAGE_UNSUPPORTED",
          error: `The configured model could not read uploaded images: ${message}`,
        },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

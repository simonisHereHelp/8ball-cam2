import { Buffer } from "buffer";

import { NextResponse } from "next/server";

import { GPT_Router } from "@/lib/gptRouter";
import {
  CANONICALS_BIBLE_SOURCE,
  PROMPT_SUMMARY_SOURCE,
} from "@/lib/jsonCanonSources";

const isImageUnsupportedError = (message: string) =>
  /image input is not supported|provide the mmproj/i.test(message);

const buildMultiImageContent = (userPrompt: string, imageUrls: string[]) => [
  {
    type: "text" as const,
    text: [
      `以下提供同一份文件的 ${imageUrls.length} 張影像，依序代表第 1 頁到第 ${imageUrls.length} 頁。`,
      "請把它們視為同一份多頁文件，先完整閱讀全部頁面，再輸出一份最終摘要。",
      "不要只根據第一頁作答；若後續頁面補充日期、金額、明細、總額、帳號、頁尾資訊或其他關鍵內容，請一併納入。",
      userPrompt,
    ].join("\n\n"),
  },
  ...imageUrls.map((url) => ({
    type: "image_url" as const,
    image_url: { url },
  })),
];

export async function POST(req: Request) {
  const promptId = PROMPT_SUMMARY_SOURCE;
  const canonicalFileId = CANONICALS_BIBLE_SOURCE;

  try {
    const bibleData = await GPT_Router._fetchFile(canonicalFileId);

    const [systemPrompt, userPrompt] = await Promise.all([
      GPT_Router.getSystemPrompt(promptId),
      GPT_Router.getUserPrompt(promptId, { bibleData }),
    ]);

    const formData = await req.formData();
    const imageFiles = formData.getAll("image").filter((f): f is File => f instanceof File);
    const imageUrls = await Promise.all(
      imageFiles.map(async (file) => {
        const buffer = Buffer.from(await file.arrayBuffer()).toString("base64");
        return `data:${file.type};base64,${buffer}`;
      }),
    );

    if (!imageUrls.length) {
      return NextResponse.json({ error: "No images were provided." }, { status: 400 });
    }

    const summary = await GPT_Router.getChatCompletionText({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildMultiImageContent(userPrompt, imageUrls) },
      ],
      temperature: 0,
      max_tokens: 220,
    });

    return NextResponse.json({ summary });
  } catch (err: any) {
    console.error("Summarize Error:", err);
    const message = err?.message || "Unknown summarize error";

    if (isImageUnsupportedError(message)) {
      const model = GPT_Router.getModelName();
      return NextResponse.json(
        {
          code: "LOCAL_LLM_IMAGE_UNSUPPORTED",
          error: `The local model "${model}" is running in text-only mode, so it cannot read uploaded images.`,
          hint:
            "Start llama-server with a vision-capable model plus --mmproj, or switch summarize to a vision backend.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

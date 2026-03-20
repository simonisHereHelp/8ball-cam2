import { Buffer } from "buffer";

import { NextResponse } from "next/server";

import { getLatestTrainingExamples } from "@/lib/driveTrainingExamples";
import { GPT_Router } from "@/lib/gptRouter";
import {
  CANONICALS_BIBLE_SOURCE,
  PROMPT_SUMMARY_SOURCE,
} from "@/lib/jsonCanonSources";

const isImageUnsupportedError = (message: string) =>
  /image input is not supported|provide the mmproj/i.test(message);

const buildTrainingSection = async () => {
  let examples = [] as Awaited<ReturnType<typeof getLatestTrainingExamples>>;
  try {
    examples = await getLatestTrainingExamples(2);
  } catch (err) {
    console.warn("Unable to load training examples for summarize:", err);
  }

  if (!examples.length) {
    return {
      promptAddon: "",
      content: [] as Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >,
    };
  }

  const distilledRules = Array.from(
    new Set(examples.map((example) => example.correctionNote.trim()).filter(Boolean)),
  )
    .slice(0, 4)
    .map((note) => `- ${note}`)
    .join("\n");

  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];

  examples.forEach((example, index) => {
    content.push({
      type: "text",
      text: [
        `歷史修正案例 ${index + 1}：`,
        `原始摘要：\n${example.originalSummary || "(無)"}`,
        `人工修正後摘要：\n${example.finalSummary}`,
        `修正說明：${example.correctionNote || "請依據可見證據修正。"}\n`,
      ].join("\n\n"),
    });

    example.imageDataUrls.forEach((url) => {
      content.push({
        type: "image_url",
        image_url: { url },
      });
    });
  });

  return {
    promptAddon: [
      "",
      "【動態歷史修正規則】",
      distilledRules || "- 若無相似案例，請僅依目前影像內容保守判斷。",
      "",
      "【歷史案例使用原則】",
      "- 只學習修正模式，不可複製案例中的名稱、日期、金額、地址、帳號到目前文件。",
      "- 若歷史案例與目前影像衝突，必須以目前影像證據為準。",
      "- 歷史案例是為了避免重複犯錯，不是要你把新文件套成舊文件。",
    ].join("\n"),
    content,
  };
};

export async function POST(req: Request) {
  const promptId = PROMPT_SUMMARY_SOURCE;
  const canonicalFileId = CANONICALS_BIBLE_SOURCE;

  try {
    const bibleData = await GPT_Router._fetchFile(canonicalFileId);

    const [systemPrompt, userPrompt] = await Promise.all([
      GPT_Router.getSystemPrompt(promptId),
      GPT_Router.getUserPrompt(promptId, { bibleData }),
    ]);
    const trainingSection = await buildTrainingSection();

    const formData = await req.formData();
    const imageFiles = formData.getAll("image").filter((f): f is File => f instanceof File);
    const imageUrls = await Promise.all(
      imageFiles.map(async (file) => {
        const buffer = Buffer.from(await file.arrayBuffer()).toString("base64");
        return `data:${file.type};base64,${buffer}`;
      }),
    );

    const content = [
      {
        type: "text" as const,
        text: `${userPrompt}${trainingSection.promptAddon}`,
      },
      ...trainingSection.content,
      {
        type: "text" as const,
        text: "以下是目前待摘要的文件影像。請依據目前影像可見內容輸出最終摘要。",
      },
      ...imageUrls.map((url) => ({
        type: "image_url" as const,
        image_url: { url },
      })),
    ];

    const summary = await GPT_Router.getChatCompletionText({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
      temperature: 0,
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

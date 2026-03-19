import { NextResponse } from "next/server";

import { GPT_Router } from "@/lib/gptRouter";
import {
  CANONICALS_BIBLE_SOURCE,
  PROMPT_SUMMARY_SOURCE,
} from "@/lib/jsonCanonSources";

const isImageUnsupportedError = (message: string) =>
  /image input is not supported|provide the mmproj/i.test(message);

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

    const content = [
      { type: "text" as const, text: userPrompt },
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

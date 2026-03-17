import { NextResponse } from "next/server";

import { GPT_Router } from "@/lib/gptRouter";
import {
  CANONICALS_BIBLE_SOURCE,
  PROMPT_SUMMARY_SOURCE,
} from "@/lib/jsonCanonSources";

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
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

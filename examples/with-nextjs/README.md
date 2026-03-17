# with-nextjs

This Next.js example keeps the existing capture -> summarize -> route -> save workflow, but the LLM backend is now a local `llama.cpp` service exposed through Cloudflare at `https://lenovo.ishere.help`.

## LLM configuration

Set this environment variable for the app:

```env
LLAMA_CPP_BASE_URL=https://lenovo.ishere.help
```

If `LLAMA_CPP_BASE_URL` is omitted, the app defaults to `https://lenovo.ishere.help` and calls the OpenAI-compatible endpoint at `/v1/chat/completions`.

## Getting started

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Notes

- All former OpenAI chat-completion calls in the example app now route through `examples/with-nextjs/lib/gptRouter.ts`.
- Google Drive reads/writes and NextAuth behavior are unchanged.
- The summarize route still sends images using the OpenAI-compatible message shape expected by `llama.cpp`. For best results, the endpoint must support the image inputs your selected model can handle.

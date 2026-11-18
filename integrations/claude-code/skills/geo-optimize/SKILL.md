---
name: geo-optimize
description: Atomize, score, and rewrite a page so AI answer engines can cite it. Use when the user says "/geo optimize <url>" or asks to improve a page for citation.
---

# GEO optimize

The user wants a page rewritten into citable passages. The URL is the argument after `/geo optimize`, or a URL or draft they pasted.

1. Call `optimize_content` with `url` when you have a public URL. Pass `text` when the user pasted copy. Pass `pageId` only when a GeoCiteOps page id is already known.
2. Lead with the overall score, how many atoms were rewritten, and the weakest atoms from the result.
3. Quote rewritten text only when it is in the tool result. Do not invent a rewrite the tool did not return.
4. This tool needs `GEOCITEOPS_API_KEY` and the workspace LLM. If the key is missing, say so. Do not substitute your own rewrite and present it as the GeoCiteOps score.

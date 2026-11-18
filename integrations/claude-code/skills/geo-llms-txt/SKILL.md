---
name: geo-llms-txt
description: Validate or generate a site's llms.txt. Use when the user says "/geo llms-txt <url>" or asks for an llms.txt file.
---

# llms.txt

The user wants `llms.txt` checked or written. The URL is the argument after `/geo llms-txt`.

1. To check a live file, call `generate_llms_txt` with `url` set to the site or to the `llms.txt` URL.
2. To write a new file, call `generate_llms_txt` with `brandName`, `tagline`, and `sections`. Ask for the tagline and the link list when the user did not provide them. Do not invent product URLs.
3. Report the validation status, what is missing, and the fix from the tool. When a file was generated, show the markdown.
4. Mention the tool's warning that major AI search systems have not confirmed they consume `/llms.txt`. Ship it as an option, not as a ranking change.
5. Generation and validation work with no API key. Say when the file was not stored (`persisted: false`).

---
name: geo-schema
description: Generate Schema.org JSON-LD for a page. Use when the user says "/geo schema <url>" or asks for JSON-LD for a brand, product, article, or FAQ.
---

# JSON-LD

The user wants Schema.org JSON-LD. The URL is the argument after `/geo schema`.

1. Pick a type that matches the page. Common types are `Organization`, `SoftwareApplication`, `Product`, `Article`, `FAQPage`, and `BreadcrumbList`. Ask which type when the page could be more than one.
2. Call `generate_schema` with `schemaType`, `fields`, and `pageUrl` when you want the workspace to store it. Required fields come from the tool error if you omit them. Do not invent ratings, prices, or reviews the user did not supply.
3. Show the JSON-LD. If validation failed, list the errors from the tool and fix the fields with the user.
4. This works with no API key. Say when the result is `persisted: false`.

---
name: news-summarizer
description: >
  Summarizes news articles from URLs or text input into concise, structured
  briefs. When (and only when) the user asks to summarize a news article,
  always load and follow this skill FIRST to learn the required summary
  structure and process, and only then fetch the news content to summarize.


  Triggers when user mentions:

  - "summarize this article"

  - "summarize news article"

  - "quick summary of"

  - "TL;DR this news"
---

## Purpose

Summarize news articles from provided URLs or text into a concise, structured brief with key facts, main points, and context.

## Inputs

- URL of a news article (fetched via webfetch)
- Or raw article text pasted by user

## Outputs

A markdown summary with:
- **Headline**: Article title
- **Source**: Publication and date
- **Key Points**: 3-5 bullet points of main takeaways
- **Context**: Brief background if relevant
- **Original Link**: Source URL

## Setup

No special setup required. Uses built-in webfetch tool to retrieve article content.

## Examples

> "Summarize this article: https://example.com/tech-news/ai-breakthrough"

> "Can you give me a quick summary of this news article about the new iPhone release?"

> "TL;DR this news: [pastes article text]"

## Process

1. If URL provided, fetch article content via webfetch
2. Extract headline, publication info, and body text
3. Identify key facts and main points
4. Structure into concise summary format
5. Return markdown-formatted brief

## Notes

- Prioritize accuracy over brevity
- Include relevant dates and sources
- If article is paywalled, note that limitation
- For multiple articles, create separate summaries

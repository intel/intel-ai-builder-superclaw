const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XML_PROLOG = /^(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE\s+svg[^>]*>\s*)?/i;

/**
 * Draws a fenced SVG block as an image, with its source in a collapsed
 * `<details>` under it. Returns null when the fence is not a complete SVG, so
 * the caller keeps its plain code card.
 *
 * The SVG goes through `<img>` and a data URI, never into the DOM: an image
 * SVG runs in secure static mode (no script, no event handlers, no external
 * fetches), and inline markup would reopen the XSS surface that escaping
 * `renderer.html` closed.
 */
export function renderSvgFence(text: string, lang: string, codeBlockHtml: string): string | null {
  const language = lang.trim().toLowerCase();
  if (language && language !== "svg" && language !== "xml") return null;
  const source = text.trim();
  const prolog = XML_PROLOG.exec(source)?.[0] ?? "";
  const body = source.slice(prolog.length);
  // A fence still streaming in has no closing tag yet; show it as source until it does.
  if (!/^<svg[\s>]/i.test(body) || !/<\/svg>$/i.test(body)) return null;
  const svg = drawableSvg(prolog, body);
  if (!svg) return null;
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return (
    `<figure class="my-4"><img src="${src}" alt="SVG diagram" loading="lazy" decoding="async" class="max-w-full h-auto rounded-control" /></figure>` +
    `<details class="my-2"><summary class="text-tiny text-dls-muted cursor-pointer">SVG source</summary>${codeBlockHtml}</details>`
  );
}

/**
 * The SVG an image can draw, or null when the XML is malformed (an unescaped
 * `&`, a masked `<ORG_1>` placeholder) and the image would break. A parsed
 * document runs no script and loads nothing.
 */
function drawableSvg(prolog: string, body: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(prolog + body, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.getElementsByTagName("parsererror").length > 0 || root.localName !== "svg") return null;
  if (root.namespaceURI === SVG_NAMESPACE) return prolog + body;
  // An SVG image without the namespace is parsed as unknown XML and draws nothing.
  if (root.namespaceURI === null && !root.hasAttribute("xmlns")) {
    return prolog + body.replace(/^<svg/i, `<svg xmlns="${SVG_NAMESPACE}"`);
  }
  return null;
}

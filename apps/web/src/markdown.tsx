import { useMemo, type ReactNode, type SyntheticEvent } from "react";

/**
 * Minimal, XSS-safe markdown renderer for agent output.
 * Produces React nodes directly (no dangerouslySetInnerHTML).
 * Supports: fenced code blocks, headings, lists, blockquotes, hr,
 * paragraphs, inline code, bold, italic, strikethrough, links.
 */
export function Markdown({ text, imageSrc }: { text: string; imageSrc?: (src: string) => string }) {
  const blocks = useMemo(() => renderBlocks(text, imageSrc), [text, imageSrc]);
  return <div className="markdown-body">{blocks}</div>;
}

function renderBlocks(text: string, imageSrc?: (src: string) => string): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const isBlockStart = (line: string) => /^```|^#{1,6}\s|^\s*>|^\s*([-*+]|\d+[.)])\s+|^\s*([-*_]\s*){3,}$/.test(line);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (/^```/.test(line)) {
      const buffer: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buffer.push(lines[i++]);
      i++; // skip closing fence
      blocks.push(<pre key={key++}><code>{buffer.join("\n")}</code></pre>);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const Tag = `h${level}` as "h1";
      blocks.push(<Tag key={key++}>{renderInline(heading[2], `h${key}`, imageSrc)}</Tag>);
      i++;
      continue;
    }

    if (/^\s*([-*_]\s*){3,}$/.test(line)) { blocks.push(<hr key={key++} />); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      const buffer: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buffer.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={key++}>{renderInline(buffer.join("\n"), `q${key}`, imageSrc)}</blockquote>);
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      const Tag = ordered ? "ol" as const : "ul" as const;
      blocks.push(<Tag key={key++}>{items.map((item, j) => <li key={j}>{renderInline(item, `li${key}-${j}`, imageSrc)}</li>)}</Tag>);
      continue;
    }

    const buffer: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buffer.push(lines[i++]);
    blocks.push(<p key={key++}>{renderInline(buffer.join("\n"), `p${key}`, imageSrc)}</p>);
  }
  return blocks;
}

const INLINE = /(!\[[^\]\n]*\]\([^)\s]+\))|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))|(\/[^\s()]+\.(?:png|jpe?g|gif|webp|svg))/gi;

/** Swap a broken image (e.g. deleted temp file) back to a plain code label. */
function imageFallback(event: SyntheticEvent<HTMLImageElement>) {
  const img = event.currentTarget;
  const code = document.createElement("code");
  code.textContent = img.dataset.raw ?? img.getAttribute("src") ?? "";
  img.replaceWith(code);
}

function renderImage(rawSrc: string, alt: string, key: string, imageSrc?: (src: string) => string): ReactNode {
  const src = imageSrc ? imageSrc(rawSrc) : rawSrc;
  if (!/^(https?:|data:|blob:)/.test(src) && !src.startsWith("/api/")) return <code key={key}>{rawSrc}</code>;
  return <img key={key} src={src} alt={alt} data-raw={rawSrc} loading="lazy" onError={imageFallback} />;
}

function renderInline(text: string, keyPrefix: string, imageSrc?: (src: string) => string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index;
    if (index > last) nodes.push(...withBreaks(text.slice(last, index), `${keyPrefix}-t${k}`));
    const token = match[0];
    const key = `${keyPrefix}-${k++}`;
    if (token.startsWith("!")) {
      const image = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (image) nodes.push(renderImage(image[2], image[1], key, imageSrc));
    }
    else if (token.startsWith("/")) nodes.push(imageSrc ? renderImage(token, token, key, imageSrc) : <code key={key}>{token}</code>);
    else if (token.startsWith("`")) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**") || token.startsWith("__")) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("~~")) nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link ? safeLink(link[2]) : undefined;
      if (link && href) nodes.push(<a key={key} href={href} target="_blank" rel="noreferrer">{link[1]}</a>);
      else nodes.push(token);
    } else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = index + token.length;
  }
  if (last < text.length) nodes.push(...withBreaks(text.slice(last), `${keyPrefix}-e`));
  return nodes;
}

function safeLink(value: string): string | undefined {
  const href = value.trim(); const scheme = href.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
  return !scheme || scheme === "http" || scheme === "https" || scheme === "mailto" ? href : undefined;
}

function withBreaks(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split("\n");
  const out: ReactNode[] = [];
  parts.forEach((part, index) => {
    if (index > 0) out.push(<br key={`${keyPrefix}-b${index}`} />);
    if (part) out.push(part);
  });
  return out;
}

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("does not turn unsafe URL schemes into links", () => { const html = renderToStaticMarkup(<Markdown text="[open](javascript:alert(1))" />); expect(html).not.toContain("href="); expect(html).toContain("javascript:alert(1)"); });
});

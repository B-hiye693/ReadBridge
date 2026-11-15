(() => {
  "use strict";

  const DEFAULT_MAX_LENGTH = 60000;
  const STRUCTURAL_TAGS = "h1,h2,h3,h4,p,ul,ol,pre,table,blockquote,ne-h1,ne-h2,ne-h3,ne-h4,ne-p,ne-uli,ne-oli,ne-alert-hole";
  const DOCUMENTATION_SELECTORS = [
    ".theme-doc-markdown.markdown", ".theme-doc-markdown", ".vp-doc", ".VPDoc",
    ".markdown-body", ".docs-content", ".doc-content", ".documentation",
    ".content-container", ".content__default", ".prose",
    ".yuque-doc-content", ".ne-viewer-body",
  ];
  const ARTICLE_SELECTORS = [
    ".article-content", ".article__body", ".post-content", ".entry-content",
    ".post-body", ".article-body", ".story-body", ".news-content",
  ];
  const HARD_NOISE_SELECTORS = [
    "script", "style", "noscript", "iframe", "svg", "canvas", "template",
    "form", "dialog", "input", "textarea", "select", "button", "[hidden]",
    "[aria-hidden='true']", "[style*='display: none']", "[style*='display:none']",
    "[style*='visibility: hidden']", "[style*='visibility:hidden']",
    ".ne-ui-image-ocr-text",
  ];
  const AUXILIARY_SELECTORS = [
    "nav", "aside", "[role='navigation']", "[role='complementary']",
    ".table-of-contents", ".toc", ".sidebar", ".side-bar", ".pagination",
    ".breadcrumbs", ".breadcrumb", ".page-nav", ".doc-footer",
    "#sidePanel", ".ne-toc-view", ".ne-toc-content",
  ];
  const NOISE_MARKER = /(^|[\s_-])(advert|ads?|banner|recommend|related|comment|share|social|footer|navbar|navigation|menu|login|popup|modal|cookie|pagination|breadcrumb|推广|广告|推荐|评论|分享|导航|登录)([\s_-]|$)/i;

  class UniversalContentExtractor {
    constructor(doc = document, options = {}) {
      this.document = doc;
      this.maxLength = options.maxLength || DEFAULT_MAX_LENGTH;
      this.maxBlocks = options.maxBlocks || 100;
      this._textCache = new WeakMap();
    }

    extract() {
      const body = this.document.body;
      if (!body) return this._failure("missing-body", 0, []);
      const startedAt = performance.now();
      const clone = body.cloneNode(true);
      clone.querySelectorAll(HARD_NOISE_SELECTORS.join(",")).forEach((node) => node.remove());
      const candidates = [];
      const seen = new Set();

      this._collect(clone, DOCUMENTATION_SELECTORS, "documentation", "documentation-container", candidates, seen);
      this._collect(clone, ["article", "main", "[role='main']"], "article", "semantic-main", candidates, seen);
      this._collect(clone, ARTICLE_SELECTORS, "article", "article-container", candidates, seen);

      if (!candidates.some((item) => item.accepted)) {
        const densityNodes = [...clone.querySelectorAll("section,div")]
          .filter((node) => this._rawText(node).length >= 80)
          .slice(0, 600);
        for (const node of densityNodes) this._addCandidate(node, "general", "text-density", candidates, seen);
      }

      const accepted = candidates.filter((item) => item.accepted).sort((a, b) => b.score - a.score);
      const best = accepted[0];
      if (!best) {
        const longest = candidates.sort((a, b) => b.metrics.textLength - a.metrics.textLength)[0];
        return this._failure("no-candidate-passed-quality", candidates.length, candidates, longest);
      }

      const limited = this._limitAtBlockBoundary(best.text);
      const result = {
        title: (this.document.title || "当前网页").trim().slice(0, 500),
        text: limited.text,
        url: `${location.origin}${location.pathname}`.slice(0, 2000),
        pageType: best.pageType,
        strategy: best.strategy,
        metrics: best.metrics,
        truncated: limited.truncated,
      };
      const anchored = this.buildContentBlocks();
      result.content_blocks = anchored.blocks;
      result.metrics.duplicateCount = anchored.duplicateCount || 0;
      if (anchored.blocks.length) {
        result.text = anchored.blocks.map((block) => block.text).join("\n\n");
        result.truncated = best.text.length > result.text.length;
      }
      result.metrics.extractMs = Number((performance.now() - startedAt).toFixed(1));
      const blockTypes = anchored.blocks.reduce((counts, block) => {
        counts[block.type] = (counts[block.type] || 0) + 1; return counts;
      }, {});
      console.info("ReadBridge Extractor Summary", {
        title: result.title, strategy: result.strategy, textLength: result.text.length,
        blockCount: anchored.blocks.length, blockTypes, truncated: result.truncated,
        duplicateCount: anchored.duplicateCount || 0, extractMs: result.metrics.extractMs,
      });
      this._log({ ...result, quality: "accepted", candidateCount: candidates.length });
      return result;
    }

    buildContentBlocks() {
      const root = this.findContentRoot();
      const blockIdToElement = new Map();
      const allBlocks = [];
      const headings = [];
      let totalLength = 0;
      if (!root) return { root: null, blocks: [], blockIdToElement };

      const selector = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table tr,dl dt,dl dd,figcaption,ne-h1,ne-h2,ne-h3,ne-h4,ne-h5,ne-h6,ne-p,ne-uli,ne-oli,ne-alert-hole";
      const seenText = new Set();
      let duplicateCount = 0;
      for (const element of root.querySelectorAll(selector)) {
        if (allBlocks.length >= 800) break;
        if (this._isLiveNoise(element, root)) continue;
        if (element.querySelector?.(".ne-ui-image-ocr-text")) continue;
        const tag = element.tagName.toLowerCase();
        if ((["p", "ne-p"].includes(tag) && element.closest("li,ne-uli,ne-oli")?.contains(element)) || (tag === "pre" && element.closest("pre") !== element)) continue;
        let text = "";
        let type = "paragraph";
        if (tag === "tr") {
          text = [...element.querySelectorAll(":scope > th,:scope > td")]
            .map((cell) => this._rawText(cell)).filter(Boolean).join(" | ");
          type = "table_row";
        } else if (["li", "ne-uli", "ne-oli"].includes(tag)) {
          const shallow = element.cloneNode(true);
          shallow.querySelectorAll("ul,ol").forEach((nested) => nested.remove());
          text = this._rawText(shallow);
          type = "list_item";
        } else {
          text = this._rawText(element);
          if (/^(?:h|ne-h)[1-6]$/.test(tag)) type = "heading";
          else if (tag === "blockquote") type = "quote";
          else if (tag === "pre") type = "code";
          else if (tag === "dt") type = "definition_term";
          else if (tag === "dd") type = "definition_value";
          else if (tag === "figcaption") type = "image_caption";
          else if (tag === "ne-alert-hole") type = "quote";
        }
        text = text.slice(0, 4000).trim();
        if (!text) continue;
        const fingerprint = text.replace(/\s+/g, "").toLowerCase();
        if (seenText.has(fingerprint)) { duplicateCount += 1; continue; }
        seenText.add(fingerprint);

        if (type === "heading") {
          const level = Number(tag.replace(/^ne-h|^h/, ""));
          headings.length = Math.max(0, level - 1);
          headings[level - 1] = text;
          headings.length = level;
        }
        const id = `rb-${allBlocks.length + 1}`;
        const block = {
          id,
          type,
          text,
          heading_context: headings.filter(Boolean).join(" > ").slice(0, 500),
        };
        allBlocks.push({ block, element });
      }
      // 合并同一标题下的短段，减少模型处理大量碎片的开销，又保留自然段边界。
      const compacted = [];
      for (const item of allBlocks) {
        const previous = compacted.at(-1);
        const mergeable = previous && item.block.type === "paragraph" && previous.block.type === "paragraph"
          && item.block.heading_context === previous.block.heading_context
          && previous.block.text.length + item.block.text.length + 1 <= 280;
        if (mergeable) previous.block.text += `\n${item.block.text}`;
        else compacted.push({ block: { ...item.block }, element: item.element });
      }
      // 长文按位置均匀抽样，同时始终保留标题，避免只截取文章开头。
      const wanted = new Set(compacted.filter((item) => item.block.type === "heading").map((item) => compacted.indexOf(item)));
      const slots = Math.min(Math.max(0, this.maxBlocks - wanted.size), compacted.length);
      for (let i = 0; i < slots; i += 1) wanted.add(Math.round(i * (compacted.length - 1) / Math.max(slots - 1, 1)));
      const selected = [];
      for (const index of [...wanted].sort((a, b) => a - b)) {
        const item = compacted[index];
        const separatorLength = selected.length ? 2 : 0;
        if (!item || selected.length >= this.maxBlocks || (totalLength + separatorLength + item.block.text.length > this.maxLength && selected.length)) continue;
        selected.push(item); totalLength += separatorLength + item.block.text.length;
      }
      const blocks = selected.map((item, index) => {
        const id = `rb-${index + 1}`;
        blockIdToElement.set(id, item.element);
        return { ...item.block, id };
      });
      globalThis.__readBridgeBlockRegistry = {
        root,
        blocks,
        blockIdToElement,
        createdAt: Date.now(),
        duplicateCount,
      };
      console.info("ReadBridge ContentBlocks", { Blocks: blocks.length, Root: root.tagName, TextLength: totalLength, DuplicateCount: duplicateCount });
      return globalThis.__readBridgeBlockRegistry;
    }

    findContentRoot() {
      const selectors = [...DOCUMENTATION_SELECTORS, "article", "main", "[role='main']", ...ARTICLE_SELECTORS];
      const candidates = [];
      const seen = new Set();
      selectors.forEach((selector, index) => {
        this.document.querySelectorAll(selector).forEach((element) => {
          if (seen.has(element) || element.closest("nav,aside,header,footer")) return;
          seen.add(element);
          const textLength = this._rawText(element).length;
          if (textLength < 50) return;
          const structure = element.querySelectorAll(STRUCTURAL_TAGS).length;
          const linkLength = [...element.querySelectorAll("a")].reduce((sum, link) => sum + this._rawText(link).length, 0);
          const score = textLength + structure * 90 + (selectors.length - index) * 120 - (linkLength / Math.max(textLength, 1)) * textLength * 1.7;
          candidates.push({ element, score });
        });
      });
      return candidates.sort((left, right) => right.score - left.score)[0]?.element || this.document.body || null;
    }

    _isLiveNoise(element, root) {
      if (element.closest(AUXILIARY_SELECTORS.join(","))) return true;
      let current = element;
      while (current && current !== root.parentElement) {
        const marker = `${current.id || ""} ${typeof current.className === "string" ? current.className : ""} ${current.getAttribute?.("role") || ""}`;
        if (NOISE_MARKER.test(marker)) return true;
        if (current === root) break;
        current = current.parentElement;
      }
      return false;
    }

    _collect(root, selectors, pageType, strategy, candidates, seen) {
      for (const selector of selectors) {
        root.querySelectorAll(selector).forEach((node) => this._addCandidate(node, pageType, strategy, candidates, seen));
      }
    }

    _addCandidate(node, pageType, strategy, candidates, seen) {
      if (seen.has(node)) return;
      seen.add(node);
      const candidate = node.cloneNode(true);
      this._removeCandidateNoise(candidate);
      const text = this._structuredText(candidate);
      const metrics = this._metrics(candidate, text);
      const structureCount = metrics.headingCount + metrics.paragraphCount + metrics.listItemCount + metrics.codeBlockCount + metrics.tableCount;
      const accepted = metrics.textLength >= 180 || (metrics.textLength >= 50 && structureCount >= 3);
      const typeBoost = pageType === "documentation" ? 900 : strategy === "semantic-main" ? 500 : 0;
      const score = metrics.textLength
        + metrics.headingCount * 180
        + metrics.paragraphCount * 100
        + metrics.listItemCount * 65
        + metrics.codeBlockCount * 190
        + metrics.tableCount * 260
        + typeBoost
        - metrics.linkRatio * metrics.textLength * 1.8;
      candidates.push({ pageType, strategy, text, metrics, accepted, score });
    }

    _removeCandidateNoise(root) {
      root.querySelectorAll([...HARD_NOISE_SELECTORS, ...AUXILIARY_SELECTORS].join(",")).forEach((node) => node.remove());
      root.querySelectorAll("[class],[id],[role]").forEach((node) => {
        const marker = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""} ${node.getAttribute("role") || ""}`;
        if (NOISE_MARKER.test(marker)) node.remove();
      });
    }

    _metrics(node, text) {
      const linkLength = [...node.querySelectorAll("a")].reduce((total, link) => total + this._rawText(link).length, 0);
      return {
        textLength: text.length,
        headingCount: node.querySelectorAll("h1,h2,h3,h4,ne-h1,ne-h2,ne-h3,ne-h4").length,
        paragraphCount: node.querySelectorAll("p,ne-p,ne-alert-hole").length,
        listItemCount: node.querySelectorAll("li,ne-uli,ne-oli").length,
        codeBlockCount: node.querySelectorAll("pre").length,
        tableCount: node.querySelectorAll("table").length,
        linkRatio: Number((linkLength / Math.max(this._rawText(node).length, 1)).toFixed(3)),
      };
    }

    _structuredText(root) {
      const blocks = [];
      const push = (value) => {
        const cleaned = String(value || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
        if (cleaned && blocks[blocks.length - 1] !== cleaned) blocks.push(cleaned);
      };
      const walk = (node, depth = 0) => {
        if (node.nodeType !== 1) return;
        const tag = node.tagName.toLowerCase();
        if (/^(?:h|ne-h)[1-4]$/.test(tag)) return push(`${"#".repeat(Number(tag.replace(/^ne-h|^h/, "")))} ${this._rawText(node)}`);
        if (["p", "ne-p", "ne-alert-hole"].includes(tag)) return push(this._rawText(node));
        if (tag === "pre") return push(`代码：\n\`\`\`\n${(node.textContent || "").trim()}\n\`\`\``);
        if (tag === "table") return push(this._tableText(node));
        if (tag === "blockquote") return push(`引用：${this._rawText(node)}`);
        if (tag === "ne-uli" || tag === "ne-oli") return push(`${tag === "ne-oli" ? "1." : "-"} ${this._rawText(node)}`);
        if (tag === "ul" || tag === "ol") {
          [...node.children].filter((child) => child.tagName?.toLowerCase() === "li").forEach((item, index) => {
            const shallow = item.cloneNode(true);
            shallow.querySelectorAll("ul,ol").forEach((nested) => nested.remove());
            const marker = tag === "ol" ? `${index + 1}.` : "-";
            push(`${"  ".repeat(depth)}${marker} ${this._rawText(shallow)}`);
            [...item.children].filter((child) => /^(UL|OL)$/.test(child.tagName)).forEach((nested) => walk(nested, depth + 1));
          });
          return;
        }
        [...node.children].forEach((child) => walk(child, depth));
      };
      if (root.matches?.(STRUCTURAL_TAGS)) walk(root);
      else [...root.children].forEach((child) => walk(child));
      return blocks.join("\n\n") || this._rawText(root);
    }

    _tableText(table) {
      const rows = [...table.querySelectorAll("tr")].map((row) =>
        [...row.querySelectorAll(":scope > th,:scope > td")].map((cell) => this._rawText(cell)).filter(Boolean)
      ).filter((cells) => cells.length);
      if (!rows.length) return "";
      return `表格：\n${rows.map((cells) => `| ${cells.join(" | ")} |`).join("\n")}`;
    }

    _rawText(node) {
      const cached = this._textCache.get(node);
      if (cached !== undefined) return cached;
      const value = (node.textContent || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      this._textCache.set(node, value);
      return value;
    }

    _limitAtBlockBoundary(text) {
      if (text.length <= this.maxLength) return { text, truncated: false };
      const blocks = text.split(/\n\n+/).filter(Boolean);
      const selected = [];
      let length = 0;
      for (const block of blocks) {
        if (length + block.length + 2 > this.maxLength) break;
        selected.push(block);
        length += block.length + 2;
      }
      return { text: selected.join("\n\n"), truncated: true };
    }

    _failure(reason, candidateCount, candidates, longest = null) {
      const result = {
        title: (this.document.title || "当前网页").trim().slice(0, 500),
        text: "",
        url: `${location.origin}${location.pathname}`.slice(0, 2000),
        pageType: "unknown",
        strategy: longest?.strategy || "none",
        failureReason: reason,
        candidateCount,
        metrics: longest?.metrics || { textLength: 0, headingCount: 0, paragraphCount: 0, listItemCount: 0, codeBlockCount: 0, tableCount: 0 },
      };
      this._log({ ...result, quality: "rejected" });
      return null;
    }

    _log(result) {
      const metrics = result.metrics || {};
      console.info("ReadBridge Extractor", {
        URL: result.url,
        PageType: result.pageType,
        Strategy: result.strategy,
        TextLength: metrics.textLength || 0,
        HeadingCount: metrics.headingCount || 0,
        ParagraphCount: metrics.paragraphCount || 0,
        ListItemCount: metrics.listItemCount || 0,
        CodeBlockCount: metrics.codeBlockCount || 0,
        TableCount: metrics.tableCount || 0,
        CandidateCount: result.candidateCount,
        FailureReason: result.failureReason || "",
        ExtractMs: metrics.extractMs || 0,
        DuplicateCount: result.duplicateCount || globalThis.__readBridgeBlockRegistry?.duplicateCount || 0,
        Quality: result.quality,
      });
    }
  }

  globalThis.ReadBridgeUniversalContentExtractor = UniversalContentExtractor;
})();

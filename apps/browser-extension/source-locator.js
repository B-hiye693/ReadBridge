(() => {
  "use strict";

  const PRIMARY_SELECTOR = "p,li,blockquote,tr,td,th,dt,dd,h1,h2,h3,h4,h5,h6,pre,code";
  const SECONDARY_SELECTOR = "section,div";
  const CONTENT_ROOT_SELECTORS = [
    ".theme-doc-markdown.markdown", ".theme-doc-markdown", ".vp-doc", ".VPDoc",
    ".markdown-body", ".docs-content", ".doc-content", ".documentation",
    ".content-container", ".content__default", ".prose",
    ".article-content", ".article__body", ".post-content", ".entry-content",
    ".post-body", ".article-body", ".story-body", ".news-content",
    "article", "main", "[role='main']",
  ];
  const EXCLUDED_SELECTOR = "nav,aside,header,footer,[role='navigation'],[role='complementary']";
  const NOISE_MARKER = /(^|[\s_-])(advert|ads?|banner|recommend|related|comment|share|social|footer|navbar|navigation|menu|login|popup|modal|cookie|pagination|breadcrumb|sidebar|toc|推广|广告|推荐|评论|分享|导航|登录|目录)([\s_-]|$)/i;
  const HIGHLIGHT_CLASS = "readbridge-source-highlight";
  const STYLE_ID = "readbridge-source-highlight-style";

  class SourceLocator {
    constructor(doc = document, options = {}) {
      this.document = doc;
      this.maxPrimaryCandidates = options.maxPrimaryCandidates || 1800;
      this.maxSecondaryCandidates = options.maxSecondaryCandidates || 700;
      this.highlightDuration = options.highlightDuration || 3200;
      this.getOverlayRect = options.getOverlayRect || (() => null);
      this.highlightTimer = null;
      this.highlightedElements = [];
      this.wordHighlightName = "readbridge-source-word";
    }

    static normalizeForLocation(value) {
      return String(value || "")
        .replace(/[\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/g, "")
        .replace(/[\s\t\r\n]+/g, "")
        .replace(/[|｜]/g, "")
        .trim();
    }

    locate(source) {
      if (source && typeof source === "object") return this.locateModule(source);
      return this._locateText(source);
    }

    locateModule(module) {
      const blockIds = Array.isArray(module.sourceBlockIds) ? module.sourceBlockIds : [];
      const debug = {
        Module: String(module.heading || module.label || module.word || "未命名").slice(0, 80),
        BlockIds: blockIds.slice(0, 12),
        AnchorFound: false,
        SourceTextMatch: false,
        StructuredMatch: false,
        Keywords: [],
      };
      const anchor = this.anchorMatch(blockIds);
      if (anchor) {
        debug.AnchorFound = true;
        anchor.highlightTerm = module.word || "";
        return this._moduleResult(anchor, debug);
      }

      const sourceText = String(module.sourceText || "");
      if (sourceText.trim()) {
        const textResult = this._locateText(sourceText, false);
        if (textResult.success) {
          debug.SourceTextMatch = true;
          textResult.highlightTerm = module.word || "";
          return this._moduleResult(textResult, debug);
        }
      }

      const root = this.findContentRoot();
      if (!root) return this._moduleResult({ success: false, reason: "content_root_not_found" }, debug);
      const keywords = this.extractKeywords(module);
      debug.Keywords = keywords.map((item) => item.text);
      const structured = this.structuredMatch(module, keywords, root);
      if (structured) {
        debug.StructuredMatch = true;
        return this._moduleResult({ success: true, ...structured, highlightTerm: module.word || "" }, debug);
      }
      const keyword = this.keywordMatch(module, keywords, root);
      if (keyword) return this._moduleResult({ success: true, ...keyword, highlightTerm: module.word || "" }, debug);

      const generatedText = [module.heading, module.label, module.value, module.content, module.word]
        .filter(Boolean).join(" ");
      const candidates = this.collectCandidates(root, PRIMARY_SELECTOR, this.maxPrimaryCandidates);
      const fuzzy = this.fuzzyMatch(SourceLocator.normalizeForLocation(generatedText), candidates);
      if (fuzzy && fuzzy.confidence >= 0.9) {
        return this._moduleResult({ success: true, ...fuzzy, strategy: "controlled-fuzzy", highlightTerm: module.word || "" }, debug);
      }
      return this._moduleResult({ success: false, reason: "no_reliable_match", bestConfidence: fuzzy?.confidence || 0 }, debug);
    }

    anchorMatch(blockIds) {
      if (!blockIds.length) return null;
      const registry = globalThis.__readBridgeBlockRegistry;
      const elements = blockIds
        .map((id) => registry?.blockIdToElement?.get(id))
        .filter((element) => element?.isConnected && !this._isExcluded(element));
      if (!elements.length) return null;
      return { success: true, strategy: "block-anchor", confidence: 1, elements };
    }

    _locateText(sourceText, shouldLog = true) {
      const normalizedSource = SourceLocator.normalizeForLocation(sourceText);
      if (!normalizedSource) return { success: false, reason: "empty_source" };
      const root = this.findContentRoot();
      if (!root) return { success: false, reason: "content_root_not_found" };

      const primary = this.collectCandidates(root, PRIMARY_SELECTOR, this.maxPrimaryCandidates);
      let result = this.exactMatch(normalizedSource, primary)
        || this.multiBlockMatch(normalizedSource, primary)
        || this.fuzzyMatch(normalizedSource, primary);

      if (!result) {
        const secondary = this.collectCandidates(root, SECONDARY_SELECTOR, this.maxSecondaryCandidates)
          .filter((candidate) => candidate.normalized.length <= Math.max(normalizedSource.length * 5, 900));
        result = this.exactMatch(normalizedSource, secondary)
          || this.multiBlockMatch(normalizedSource, secondary)
          || this.fuzzyMatch(normalizedSource, secondary);
      }

      if (!result) {
        if (shouldLog) this._log(normalizedSource.length, primary.length, null);
        return { success: false, reason: "no_reliable_match" };
      }
      if (shouldLog) this._log(normalizedSource.length, primary.length, result);
      return { success: true, ...result, matchedText: result.elements.map((element) => this._text(element)).join(" ") };
    }

    extractKeywords(module) {
      const keywords = [];
      const add = (value, strong = false) => {
        const text = SourceLocator.normalizeForLocation(value);
        if (text.length < 2 || text.length > 40 || keywords.some((item) => item.text === text)) return;
        keywords.push({ text, strong });
      };
      add(module.word, true);
      add(module.label || module.heading, String(module.label || module.heading || "").length >= 2);
      const content = [module.value, module.content].filter(Boolean).join(" ");
      for (const match of content.matchAll(/[A-Za-z]+(?:[-_.]?[A-Za-z0-9]+)+|[A-Za-z]*\d+(?:\.\d+)?(?:秒|分钟|小时|天|年|月|日|路|个|次|%|％)?/g)) add(match[0], true);
      for (const match of content.matchAll(/(?:是|为|使用|采用|支持|包括|需要|共有|属于)([\u3400-\u9FFFA-Za-z0-9_.-]{2,16})/g)) {
        const cleaned = match[1].replace(/(?:进行|一种|相关|数字输入|身份认证|认证机制)$/g, "");
        add(cleaned || match[1], true);
      }
      return keywords.slice(0, 8);
    }

    structuredMatch(module, keywords, root) {
      const structured = this.collectCandidates(root, "tr,li,dt,dd", 1000);
      return this._rankKeywordCandidates(module, keywords, structured, "structured");
    }

    keywordMatch(module, keywords, root) {
      if (!keywords.length) return null;
      const candidates = this.collectCandidates(root, PRIMARY_SELECTOR, this.maxPrimaryCandidates);
      return this._rankKeywordCandidates(module, keywords, candidates, "keyword");
    }

    _rankKeywordCandidates(module, keywords, candidates, kind) {
      if (!keywords.length) return null;
      const scored = [];
      for (const candidate of candidates) {
        const matched = keywords.filter((keyword) => candidate.normalized.includes(keyword.text));
        const strong = matched.filter((keyword) => keyword.strong);
        const isWordModule = Boolean(module.word);
        if (isWordModule && strong.some((item) => item.text === SourceLocator.normalizeForLocation(module.word))) {
          scored.push({ candidate, confidence: matched.length >= 2 ? 0.96 : 0.91, matched });
          continue;
        }
        if (strong.length >= 2 || (strong.length >= 1 && matched.length >= 2)) {
          const semanticBoost = /^(TR|LI|DT|DD)$/.test(candidate.element.tagName) ? 0.03 : 0;
          scored.push({ candidate, confidence: Math.min(0.97, 0.88 + strong.length * 0.025 + matched.length * 0.01 + semanticBoost), matched });
        }
      }
      scored.sort((left, right) => right.confidence - left.confidence
        || right.matched.length - left.matched.length
        || left.candidate.normalized.length - right.candidate.normalized.length);
      if (!scored.length || scored[0].confidence < 0.9) return null;
      if (scored[1]
        && scored[0].confidence - scored[1].confidence < 0.025
        && scored[0].matched.length === scored[1].matched.length) return null;
      return {
        strategy: kind === "structured" ? `${scored[0].candidate.element.tagName.toLowerCase()}-fields` : "keywords",
        confidence: scored[0].confidence,
        elements: [scored[0].candidate.element],
      };
    }

    _moduleResult(result, debug) {
      const output = result.success ? result : { success: false, reason: result.reason || "no_reliable_match" };
      console.info("ReadBridge SourceLocator", {
        ...debug,
        Strategy: result.strategy || "none",
        Confidence: Number((result.confidence || result.bestConfidence || 0).toFixed(3)),
        Result: result.success ? "success" : "rejected",
      });
      return output;
    }

    findContentRoot() {
      const roots = [];
      const seen = new Set();
      for (const selector of CONTENT_ROOT_SELECTORS) {
        for (const element of this.document.querySelectorAll(selector)) {
          if (seen.has(element) || this._isExcluded(element)) continue;
          seen.add(element);
          const textLength = SourceLocator.normalizeForLocation(element.textContent).length;
          if (textLength < 50) continue;
          const structure = element.querySelectorAll(PRIMARY_SELECTOR).length;
          const linkLength = [...element.querySelectorAll("a")].reduce(
            (total, link) => total + SourceLocator.normalizeForLocation(link.textContent).length, 0,
          );
          const linkRatio = linkLength / Math.max(textLength, 1);
          const selectorPriority = Math.max(0, CONTENT_ROOT_SELECTORS.length - CONTENT_ROOT_SELECTORS.indexOf(selector));
          roots.push({ element, score: textLength + structure * 90 + selectorPriority * 120 - linkRatio * textLength * 1.7 });
        }
      }
      if (roots.length) return roots.sort((left, right) => right.score - left.score)[0].element;
      return this.document.body || null;
    }

    collectCandidates(root, selector, limit) {
      const candidates = [];
      for (const element of root.querySelectorAll(selector)) {
        if (candidates.length >= limit) break;
        if (this._isExcluded(element) || !this._isVisible(element)) continue;
        const normalized = SourceLocator.normalizeForLocation(element.textContent);
        if (normalized.length < 4 || normalized.length > 8000) continue;
        candidates.push({ element, normalized });
      }
      if (root.matches?.(selector) && !this._isExcluded(root)) {
        const normalized = SourceLocator.normalizeForLocation(root.textContent);
        if (normalized.length >= 4 && normalized.length <= 8000) candidates.unshift({ element: root, normalized });
      }
      return candidates;
    }

    exactMatch(source, candidates) {
      const matches = [];
      for (const candidate of candidates) {
        let rank = 0;
        let confidence = 0;
        if (candidate.normalized === source) {
          rank = 3; confidence = 1;
        } else if (candidate.normalized.includes(source)) {
          rank = 2; confidence = Math.max(0.96, source.length / candidate.normalized.length);
        } else if (source.includes(candidate.normalized)
          && candidate.normalized.length >= 24
          && source.length - candidate.normalized.length <= 12) {
          rank = 1; confidence = candidate.normalized.length / source.length;
        }
        if (rank) matches.push({ candidate, rank, confidence });
      }
      if (!matches.length) return null;
      matches.sort((left, right) => right.rank - left.rank
        || right.confidence - left.confidence
        || left.candidate.normalized.length - right.candidate.normalized.length);
      const best = matches[0];
      return { strategy: best.rank === 3 ? "exact" : "contains", confidence: best.confidence, elements: [best.candidate.element] };
    }

    multiBlockMatch(source, candidates) {
      let best = null;
      for (let start = 0; start < candidates.length; start += 1) {
        let combined = "";
        const elements = [];
        for (let count = 0; count < 3 && start + count < candidates.length; count += 1) {
          const current = candidates[start + count];
          if (count && !this._areAdjacent(candidates[start + count - 1].element, current.element)) break;
          combined += current.normalized;
          elements.push(current.element);
          if (count === 0) continue;
          if (combined === source || combined.includes(source)) {
            const confidence = combined === source ? 1 : Math.max(0.95, source.length / combined.length);
            const match = { strategy: "multi-block", confidence, elements: [...elements] };
            if (!best || confidence > best.confidence || (confidence === best.confidence && elements.length < best.elements.length)) best = match;
          }
        }
      }
      return best;
    }

    fuzzyMatch(source, candidates) {
      if (source.length < 24) return null;
      const scored = [];
      for (let start = 0; start < candidates.length; start += 1) {
        let combined = "";
        const elements = [];
        for (let count = 0; count < 3 && start + count < candidates.length; count += 1) {
          const current = candidates[start + count];
          if (count && !this._areAdjacent(candidates[start + count - 1].element, current.element)) break;
          combined += current.normalized;
          elements.push(current.element);
          if (combined.length < 12 || combined.length > source.length * 2.2) continue;
          const confidence = this._similarity(source, combined);
          const edgeMatch = this._edgeAgreement(source, combined);
          if (confidence >= 0.88 && edgeMatch >= 0.5) scored.push({ strategy: "fuzzy", confidence, elements: [...elements] });
        }
      }
      scored.sort((left, right) => right.confidence - left.confidence || left.elements.length - right.elements.length);
      if (!scored.length) return null;
      if (scored[1] && scored[0].confidence - scored[1].confidence < 0.035) return null;
      return scored[0];
    }

    scrollToMatch(result) {
      if (!result?.success || !result.elements?.length) return false;
      const target = result.elements[0];
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      this.highlightMatch(result.elements, result.highlightTerm || "");
      setTimeout(() => this._compensateOverlay(target), 420);
      return true;
    }

    highlightMatch(elements, word = "") {
      this.clearHighlight();
      this._ensureHighlightStyle();
      this.highlightedElements = elements.filter((element) => element?.isConnected);
      this.highlightedElements.forEach((element) => element.classList.add(HIGHLIGHT_CLASS));
      if (word) this._highlightWord(this.highlightedElements, word);
      this.highlightTimer = setTimeout(() => this.clearHighlight(), this.highlightDuration);
    }

    clearHighlight() {
      clearTimeout(this.highlightTimer);
      this.highlightTimer = null;
      this.highlightedElements.forEach((element) => element?.classList?.remove(HIGHLIGHT_CLASS));
      this.highlightedElements = [];
      globalThis.CSS?.highlights?.delete?.(this.wordHighlightName);
    }

    _isExcluded(element) {
      if (!element || element.closest(EXCLUDED_SELECTOR)) return true;
      const markerNode = element.closest("[class],[id],[role]");
      const marker = markerNode ? `${markerNode.id || ""} ${typeof markerNode.className === "string" ? markerNode.className : ""} ${markerNode.getAttribute("role") || ""}` : "";
      return NOISE_MARKER.test(marker);
    }

    _isVisible(element) {
      if (!element.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
      const style = this.document.defaultView?.getComputedStyle?.(element);
      return !style || (style.display !== "none" && style.visibility !== "hidden");
    }

    _areAdjacent(left, right) {
      if (!left || !right || left === right || left.contains(right) || right.contains(left)) return false;
      const position = left.compareDocumentPosition(right);
      if (!(position & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      let cursor = left.nextElementSibling;
      while (cursor && this._isExcluded(cursor)) cursor = cursor.nextElementSibling;
      return cursor === right || left.parentElement === right.parentElement;
    }

    _similarity(left, right) {
      if (left === right) return 1;
      const grams = (value) => {
        const result = new Map();
        for (let index = 0; index < value.length - 1; index += 1) {
          const gram = value.slice(index, index + 2);
          result.set(gram, (result.get(gram) || 0) + 1);
        }
        return result;
      };
      const leftGrams = grams(left);
      const rightGrams = grams(right);
      let overlap = 0;
      for (const [gram, count] of leftGrams) overlap += Math.min(count, rightGrams.get(gram) || 0);
      return (2 * overlap) / Math.max(left.length + right.length - 2, 1);
    }

    _edgeAgreement(source, candidate) {
      const size = Math.min(40, Math.floor(source.length / 2));
      if (size < 8) return 0;
      const start = source.slice(0, size);
      const end = source.slice(-size);
      return (candidate.includes(start) ? 0.5 : 0) + (candidate.includes(end) ? 0.5 : 0);
    }

    _compensateOverlay(target) {
      if (!target?.isConnected) return;
      const overlay = this.getOverlayRect?.();
      if (!overlay || overlay.width <= 0 || overlay.height <= 0) return;
      const rect = target.getBoundingClientRect();
      const overlapWidth = Math.max(0, Math.min(rect.right, overlay.right) - Math.max(rect.left, overlay.left));
      const overlapHeight = Math.max(0, Math.min(rect.bottom, overlay.bottom) - Math.max(rect.top, overlay.top));
      const overlapArea = overlapWidth * overlapHeight;
      const targetArea = Math.max(rect.width * rect.height, 1);
      if (overlapArea / targetArea < 0.45) return;
      const roomAbove = overlay.top;
      const desiredTop = roomAbove >= Math.min(rect.height + 40, innerHeight * 0.4)
        ? Math.max(20, overlay.top - rect.height - 24)
        : Math.min(innerHeight - rect.height - 20, overlay.bottom + 24);
      window.scrollBy({ top: rect.top - desiredTop, behavior: "smooth" });
    }

    _ensureHighlightStyle() {
      if (this.document.getElementById(STYLE_ID)) return;
      const style = this.document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `.${HIGHLIGHT_CLASS}{background-color:rgba(255,222,89,.34)!important;outline:2px solid rgba(184,138,0,.62)!important;outline-offset:3px!important;border-radius:3px!important;transition:background-color .28s ease,outline-color .28s ease!important;}::highlight(${this.wordHighlightName}){background-color:rgba(255,190,35,.72);color:inherit;text-decoration:underline 2px rgba(120,82,0,.7);}`;
      (this.document.head || this.document.documentElement).appendChild(style);
    }

    _highlightWord(elements, word) {
      if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== "function") return false;
      const needle = String(word || "").trim().toLocaleLowerCase();
      if (!needle) return false;
      for (const element of elements) {
        const walker = this.document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const index = String(node.nodeValue || "").toLocaleLowerCase().indexOf(needle);
          if (index < 0) continue;
          const range = this.document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + needle.length);
          globalThis.CSS.highlights.set(this.wordHighlightName, new globalThis.Highlight(range));
          return true;
        }
      }
      return false;
    }

    _text(element) {
      return String(element?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
    }

    _log(sourceLength, candidates, result) {
      console.info("ReadBridge SourceLocator", {
        SourceLength: sourceLength,
        Candidates: candidates,
        Strategy: result?.strategy || "none",
        Confidence: result ? Number(result.confidence.toFixed(3)) : 0,
        MatchedBlocks: result?.elements?.length || 0,
      });
    }
  }

  globalThis.ReadBridgeSourceLocator = SourceLocator;
})();

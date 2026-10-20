import DOMPurify from "dompurify";
import { formatStoredMultilineText } from "./textFormat";
import { fileBusinessUrl } from "./fileBusinessUrl";

const htmlPattern = /<\/?[a-z][\s\S]*>/i;

export function isRichTextContent(value: unknown) {
    return htmlPattern.test(formatStoredMultilineText(value));
}

export function sanitizeRichText(value: unknown, fallback = "") {
    const sanitized = DOMPurify.sanitize(formatStoredMultilineText(value, fallback), {
        USE_PROFILES: { html: true },
        ADD_TAGS: ["figure", "figcaption"],
        ADD_ATTR: ["alt", "class", "height", "rel", "sizes", "src", "srcset", "style", "target", "width"],
    });
    if (typeof document === "undefined") return sanitized;
    const container = document.createElement("div");
    container.innerHTML = sanitized;
    for (const element of container.querySelectorAll("[src], [href], [poster]")) {
        for (const attribute of ["src", "href", "poster"]) {
            const original = element.getAttribute(attribute);
            if (!original) continue;
            const scoped = fileBusinessUrl(original);
            if (scoped !== original) {
                element.setAttribute(attribute, scoped);
                if (attribute === "src") element.removeAttribute("srcset");
            }
        }
    }
    return container.innerHTML;
}

export function getPlainTextFromRichText(value: unknown, fallback = "") {
    const content = formatStoredMultilineText(value, fallback);

    if (!isRichTextContent(content)) {
        return content;
    }

    if (typeof document === "undefined") {
        return content
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    const container = document.createElement("div");
    container.innerHTML = sanitizeRichText(content);

    return (container.textContent || container.innerText || "").replace(/\s+/g, " ").trim();
}

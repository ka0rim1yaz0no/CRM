import type { Editor, FileLoader, UploadAdapter, UploadResponse } from "ckeditor5";
import {
    AutoImage,
    BlockQuote,
    Bold,
    ClassicEditor,
    Essentials,
    FileRepository,
    FontSize,
    Heading,
    Image,
    ImageCaption,
    ImageResize,
    ImageStyle,
    ImageToolbar,
    ImageUpload,
    Italic,
    Link as CkLink,
    List,
    Paragraph,
    Table,
    TableToolbar,
    Underline,
    Undo,
} from "ckeditor5";
import { uploadKnowledgeBasePhoto } from "../../../api/knowledgeBase";
import { backendOrigin } from "../../../lib/backendUrl";
import { fileBusinessUrl } from "../../../lib/fileBusinessUrl";

export { ClassicEditor };

function getUploadedImageUrl(url: string) {
    const cleanUrl = String(url || "").trim();
    const uploadPrefix = "/uploads/knowledge-base/";

    if (!cleanUrl) return "";
    if (/^(https?:|data:|blob:)/i.test(cleanUrl)) return fileBusinessUrl(cleanUrl);
    if (cleanUrl.startsWith(uploadPrefix)) {
        return fileBusinessUrl(`${backendOrigin}/api/knowledge-base/photos/file/${encodeURIComponent(cleanUrl.slice(uploadPrefix.length))}`);
    }

    return fileBusinessUrl(`${backendOrigin}${cleanUrl.startsWith("/") ? cleanUrl : `/${cleanUrl}`}`);
}

function dataUrlToImageFile(dataUrl: string, index: number) {
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

    if (!match) {
        throw new Error("Unsupported pasted image format.");
    }

    const mimeType = match[1];
    const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : mimeType === "image/gif" ? "gif" : "jpg";
    const binary = atob(match[2].replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);

    for (let position = 0; position < binary.length; position += 1) {
        bytes[position] = binary.charCodeAt(position);
    }

    return new File([bytes], `pasted-image-${index}.${extension}`, { type: mimeType });
}

export async function normalizeKnowledgeBaseRichTextImages(html: string) {
    if (!html.includes("data:image/") || typeof DOMParser === "undefined") {
        return html;
    }

    const document = new DOMParser().parseFromString(html, "text/html");
    const inlineImages = Array.from(document.querySelectorAll<HTMLImageElement>('img[src^="data:image/"]'));

    if (!inlineImages.length) {
        return html;
    }

    await Promise.all(
        inlineImages.map(async (image, index) => {
            const source = image.getAttribute("src") || "";
            const { url } = await uploadKnowledgeBasePhoto(dataUrlToImageFile(source, index + 1));

            image.setAttribute("src", getUploadedImageUrl(url));
            image.removeAttribute("srcset");
        })
    );

    return document.body.innerHTML;
}

class KnowledgeBaseImageUploadAdapter implements UploadAdapter {
    private loader: FileLoader;

    constructor(loader: FileLoader) {
        this.loader = loader;
    }

    async upload(): Promise<UploadResponse> {
        const file = await this.loader.file;

        if (!file) {
            throw new Error("No image file selected.");
        }

        const { url } = await uploadKnowledgeBasePhoto(file);

        return {
            default: getUploadedImageUrl(url),
        };
    }

    abort() {
        // The app upload API uses a single request helper, so there is no active request handle to cancel here.
    }
}

function KnowledgeBaseImageUploadAdapterPlugin(editor: Editor) {
    editor.plugins.get(FileRepository).createUploadAdapter = (loader) => new KnowledgeBaseImageUploadAdapter(loader);
}

const imageFreePositionAttribute = "kbImagePosition";

function normalizeImageOffset(value: unknown) {
    const [rawX = "0", rawY = "0"] = String(value || "0,0").split(",");
    const x = Number.parseFloat(rawX);
    const y = Number.parseFloat(rawY);

    return {
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
    };
}

function getImageOffsetFromStyles(viewElement: { getStyle: (property: string) => string | undefined }) {
    const left = Number.parseFloat(viewElement.getStyle("left") || "0");
    const top = Number.parseFloat(viewElement.getStyle("top") || "0");

    if (!Number.isFinite(left) && !Number.isFinite(top)) return null;

    return `${Number.isFinite(left) ? left : 0},${Number.isFinite(top) ? top : 0}`;
}

function KnowledgeBaseImageFreePositionPlugin(editor: Editor) {
    const schema = editor.model.schema;

    if (schema.isRegistered("imageBlock")) {
        schema.extend("imageBlock", { allowAttributes: [imageFreePositionAttribute] });
    }

    if (schema.isRegistered("imageInline")) {
        schema.extend("imageInline", { allowAttributes: [imageFreePositionAttribute] });
    }

    const imagePositionView = (value: unknown) => {
        const { x, y } = normalizeImageOffset(value);

        if (Math.round(x) === 0 && Math.round(y) === 0) return null;

        return {
            key: "style",
            value: {
                position: "relative",
                left: `${Math.round(x)}px`,
                top: `${Math.round(y)}px`,
            },
        };
    };

    editor.conversion.for("downcast").attributeToAttribute({
        model: {
            name: "imageBlock",
            key: imageFreePositionAttribute,
        },
        view: imagePositionView,
        converterPriority: "high",
    });

    editor.conversion.for("downcast").attributeToAttribute({
        model: {
            name: "imageInline",
            key: imageFreePositionAttribute,
        },
        view: imagePositionView,
        converterPriority: "high",
    });

    editor.conversion.for("upcast").attributeToAttribute({
        view: {
            name: "figure",
            styles: {
                left: /-?\d+(\.\d+)?px/,
            },
        },
        model: {
            key: imageFreePositionAttribute,
            value: getImageOffsetFromStyles,
        },
        converterPriority: "high",
    });

    editor.conversion.for("upcast").attributeToAttribute({
        view: {
            name: "span",
            styles: {
                left: /-?\d+(\.\d+)?px/,
            },
        },
        model: {
            key: imageFreePositionAttribute,
            value: getImageOffsetFromStyles,
        },
        converterPriority: "high",
    });
}

function KnowledgeBaseImagePositionDragPlugin(editor: Editor) {
    let cleanup = () => {};

    editor.on("ready", () => {
        const editableElement = (editor.ui as { getEditableElement?: () => HTMLElement | null }).getEditableElement?.();

        if (!editableElement) return;

        let activeDrag:
            | {
                  widget: HTMLElement;
                  modelElement: unknown;
                  pointerId: number;
                  startX: number;
                  startY: number;
                  initialX: number;
                  initialY: number;
                  latestX: number;
                  latestY: number;
                  didMove: boolean;
              }
            | null = null;

        const getImageWidget = (target: EventTarget | null) => {
            if (!(target instanceof HTMLElement)) return null;
            return target.closest<HTMLElement>(".ck-content figure.image, .ck-content .image-inline");
        };

        const isNestedEditableTarget = (target: EventTarget | null) => {
            if (!(target instanceof HTMLElement)) return false;
            return Boolean(target.closest(".ck-editor__nested-editable, figcaption"));
        };

        const getModelElement = (widget: HTMLElement) => {
            const viewElement = editor.editing.view.domConverter.domToView(widget);

            if (!viewElement) return null;

            return editor.editing.mapper.toModelElement(viewElement as never);
        };

        const selectWidget = (modelElement: unknown) => {
            if (!modelElement) return false;

            editor.model.change((writer) => {
                writer.setSelection(modelElement as never, "on");
            });

            return true;
        };

        const setPreviewOffset = (widget: HTMLElement, x: number, y: number) => {
            widget.style.position = "relative";
            widget.style.left = `${Math.round(x)}px`;
            widget.style.top = `${Math.round(y)}px`;
        };

        const commitOffset = (modelElement: unknown, x: number, y: number) => {
            const roundedX = Math.round(x);
            const roundedY = Math.round(y);

            editor.model.change((writer) => {
                writer.setSelection(modelElement as never, "on");

                if (Math.abs(roundedX) < 1 && Math.abs(roundedY) < 1) {
                    writer.removeAttribute(imageFreePositionAttribute, modelElement as never);
                    return;
                }

                writer.setAttribute(imageFreePositionAttribute, `${roundedX},${roundedY}`, modelElement as never);
            });
            editor.editing.view.focus();
        };

        const clearActiveDrag = () => {
            if (activeDrag?.widget) {
                activeDrag.widget.classList.remove("knowledge-base-image-position-dragging");

                if (activeDrag.widget.hasPointerCapture?.(activeDrag.pointerId)) {
                    activeDrag.widget.releasePointerCapture?.(activeDrag.pointerId);
                }
            }

            activeDrag = null;
        };

        const handlePointerDown = (event: PointerEvent) => {
            if (event.button !== 0) return;
            const target = event.target;

            if (target instanceof HTMLElement && target.closest(".ck-widget__resizer__handle, .ck-widget__resizer")) {
                return;
            }

            if (isNestedEditableTarget(target)) {
                return;
            }

            const widget = getImageWidget(target);

            if (!widget) return;
            const modelElement = getModelElement(widget);

            if (!modelElement) return;

            const { x, y } = normalizeImageOffset((modelElement as { getAttribute?: (key: string) => unknown }).getAttribute?.(imageFreePositionAttribute));

            activeDrag = {
                widget,
                modelElement,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                initialX: x,
                initialY: y,
                latestX: x,
                latestY: y,
                didMove: false,
            };

            try {
                widget.setPointerCapture?.(event.pointerId);
            } catch {
                // Pointer capture is a helper for smooth dragging; window listeners still handle the fallback path.
            }
        };

        const handlePointerMove = (event: PointerEvent) => {
            if (!activeDrag) return;

            if (event.pointerId !== activeDrag.pointerId) return;

            const distanceX = Math.abs(event.clientX - activeDrag.startX);
            const distanceY = Math.abs(event.clientY - activeDrag.startY);

            activeDrag.latestX = activeDrag.initialX + event.clientX - activeDrag.startX;
            activeDrag.latestY = activeDrag.initialY + event.clientY - activeDrag.startY;

            if (distanceX > 2 || distanceY > 2) {
                if (!activeDrag.didMove) {
                    selectWidget(activeDrag.modelElement);
                    editor.editing.view.focus();
                    activeDrag.widget.classList.add("knowledge-base-image-position-dragging");
                }

                activeDrag.didMove = true;
                setPreviewOffset(activeDrag.widget, activeDrag.latestX, activeDrag.latestY);
                event.preventDefault();
                event.stopPropagation();
            }
        };

        const handlePointerUp = (event: PointerEvent) => {
            if (!activeDrag) return;

            if (event.pointerId !== activeDrag.pointerId) return;

            const didMove = activeDrag.didMove;
            const modelElement = activeDrag.modelElement;
            const latestX = activeDrag.latestX;
            const latestY = activeDrag.latestY;
            clearActiveDrag();

            if (didMove) {
                commitOffset(modelElement, latestX, latestY);
                event.preventDefault();
                event.stopPropagation();
            }
        };

        const handleDragStart = (event: DragEvent) => {
            const widget = getImageWidget(event.target);

            if (!widget) return;
            event.preventDefault();
        };

        editableElement.addEventListener("pointerdown", handlePointerDown, true);
        editableElement.addEventListener("dragstart", handleDragStart, true);
        window.addEventListener("pointermove", handlePointerMove, true);
        window.addEventListener("pointerup", handlePointerUp, true);

        cleanup = () => {
            editableElement.removeEventListener("pointerdown", handlePointerDown, true);
            editableElement.removeEventListener("dragstart", handleDragStart, true);
            window.removeEventListener("pointermove", handlePointerMove, true);
            window.removeEventListener("pointerup", handlePointerUp, true);
        };
    });

    editor.on("destroy", () => cleanup());
}

export function createKnowledgeBaseEditorConfig(placeholder: string) {
    return {
        licenseKey: "GPL",
        plugins: [
            Essentials,
            Paragraph,
            Heading,
            FontSize,
            Bold,
            Italic,
            Underline,
            CkLink,
            List,
            BlockQuote,
            Table,
            TableToolbar,
            Image,
            ImageToolbar,
            ImageCaption,
            ImageStyle,
            ImageResize,
            ImageUpload,
            AutoImage,
            KnowledgeBaseImageUploadAdapterPlugin,
            KnowledgeBaseImageFreePositionPlugin,
            KnowledgeBaseImagePositionDragPlugin,
            Undo,
        ],
        toolbar: {
            items: [
                "heading",
                "fontSize",
                "|",
                "bold",
                "italic",
                "underline",
                "|",
                "link",
                "bulletedList",
                "numberedList",
                "blockQuote",
                "|",
                "insertTable",
                "uploadImage",
            ],
            shouldNotGroupWhenFull: false,
        },
        table: {
            contentToolbar: ["tableColumn", "tableRow", "mergeTableCells"],
        },
        image: {
            resizeUnit: "%" as const,
            resizeOptions: [
                {
                    name: "resizeImage:original",
                    value: null,
                    label: "Original",
                },
                {
                    name: "resizeImage:25",
                    value: "25",
                    label: "25%",
                },
                {
                    name: "resizeImage:50",
                    value: "50",
                    label: "50%",
                },
                {
                    name: "resizeImage:75",
                    value: "75",
                    label: "75%",
                },
                {
                    name: "resizeImage:custom",
                    value: "custom",
                    label: "Custom",
                },
            ],
            toolbar: [
                "toggleImageCaption",
                "imageTextAlternative",
                "|",
                "imageStyle:inline",
                "imageStyle:block",
                "imageStyle:side",
                "|",
                "resizeImage",
            ],
        },
        link: {
            addTargetToExternalLinks: true,
            defaultProtocol: "https://",
        },
        fontSize: {
            options: [
                "default",
                { title: "12px", model: "12px" },
                { title: "14px", model: "14px" },
                { title: "16px", model: "16px" },
                { title: "18px", model: "18px" },
                { title: "20px", model: "20px" },
                { title: "24px", model: "24px" },
                { title: "28px", model: "28px" },
                { title: "32px", model: "32px" },
                { title: "36px", model: "36px" },
                { title: "48px", model: "48px" },
            ],
        },
        placeholder,
    };
}

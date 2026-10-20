import { toPng } from "html-to-image";

export function fitPayslipOnPage(imageWidth: number, imageHeight: number, pageWidth: number, pageHeight: number) {
    if (![imageWidth, imageHeight, pageWidth, pageHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error("Invalid payslip page dimensions.");
    const margin = 10 * 72 / 25.4;
    const scale = Math.min((pageWidth - margin * 2) / imageWidth, (pageHeight - margin * 2) / imageHeight);
    if (scale <= 0) throw new Error("The PDF page is too small.");
    const width = imageWidth * scale, height = imageHeight * scale;
    return { x: (pageWidth - width) / 2, y: pageHeight - margin - height, width, height };
}

export async function buildPayslipPdf(png: string | Uint8Array, title: string, paper: "A4" | "Letter" = "A4") {
    const { PDFDocument, PageSizes } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    pdf.setTitle(title, { showInWindowTitleBar: true });
    pdf.setAuthor("Assistly Payroll");
    const image = await pdf.embedPng(png);
    const page = pdf.addPage(paper === "Letter" ? PageSizes.Letter : PageSizes.A4);
    page.drawImage(image, fitPayslipOnPage(image.width, image.height, page.getWidth(), page.getHeight()));
    return new Uint8Array(await pdf.save()).buffer;
}

export async function withPdfDeadline<T>(operation: Promise<T>, milliseconds = 15_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("PDF preparation timed out. Please try again.")), milliseconds);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

export async function capturePayslipPdf(sheet: HTMLElement, title: string) {
    const snapshot = sheet.cloneNode(true) as HTMLElement;
    snapshot.removeAttribute("data-payroll-print-sheet");
    snapshot.style.visibility = "visible";
    document.body.append(snapshot);
    try {
        return await withPdfDeadline((async () => {
            await document.fonts?.ready;
            const documentElement = snapshot.querySelector<HTMLElement>(".payslip-print");
            if (!documentElement) throw new Error("The payslip document is unavailable.");
            const bounds = documentElement.getBoundingClientRect();
            if (!bounds.width || !bounds.height) throw new Error("The payslip document has no printable content.");
            const png = await toPng(documentElement, { backgroundColor: "#ffffff", pixelRatio: 3, skipFonts: true,
                width: Math.ceil(bounds.width), height: Math.ceil(bounds.height), style: { visibility: "visible" } });
            return buildPayslipPdf(png, title);
        })());
    } finally {
        snapshot.remove();
    }
}

export function downloadPayslipPdf(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function openPayslipPdf(blob: Blob, target: Window) {
    const url = URL.createObjectURL(blob);
    try { target.location.replace(url); }
    catch (error) { URL.revokeObjectURL(url); throw error; }
    // The PDF tab owns this URL until it closes, even if the payroll dialog closes first.
    const timer = setInterval(() => {
        if (target.closed) { URL.revokeObjectURL(url); clearInterval(timer); }
    }, 30_000);
}

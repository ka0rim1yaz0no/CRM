export function getPaginationItems(currentPage: number, totalPages: number) {
    if (totalPages <= 7) {
        return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    const pages = new Set([1, 2, totalPages - 1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
    const sortedPages = Array.from(pages)
        .filter((pageNumber) => pageNumber >= 1 && pageNumber <= totalPages)
        .sort((a, b) => a - b);
    const items: Array<number | "..."> = [];

    sortedPages.forEach((pageNumber) => {
        const previous = items[items.length - 1];
        if (typeof previous === "number" && pageNumber - previous > 1) {
            items.push("...");
        }
        items.push(pageNumber);
    });

    return items;
}

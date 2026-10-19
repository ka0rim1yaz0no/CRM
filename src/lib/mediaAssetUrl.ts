export function mediaAssetUrl(value: string, origin: string, businessId: string) {
    if (!value || /^https?:\/\//i.test(value)) return value;
    const url = new URL(value.startsWith("/") ? value : `/${value}`, origin || "http://crm.invalid");
    const legacyPrefix = "/uploads/media/";
    if (url.pathname.startsWith(legacyPrefix)) url.pathname = `/api/media/file/${url.pathname.slice(legacyPrefix.length)}`;
    if (url.pathname.startsWith("/api/media/file/") && businessId) url.searchParams.set("businessId", businessId);
    return origin ? url.href : `${url.pathname}${url.search}${url.hash}`;
}

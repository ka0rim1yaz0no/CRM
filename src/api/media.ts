import { api } from "../lib/api";

export type MediaAssetType = "Image" | "Video";

export type MediaAsset = {
    _id: string;
    name: string;
    url: string;
    mimeType: string;
    assetType: MediaAssetType;
    role: string;
    branch?: string;
    size: number;
    isArchived: boolean;
    createdAt?: string;
};

export async function getMediaAssets() {
    const response = await api.get<MediaAsset[]>("/media");
    return response.data;
}

export async function uploadMediaAsset({ file, role }: { file: File; role: string }) {
    if (!file.size || file.size > 50 * 1024 * 1024) throw new Error("Media files must be between 1 byte and 50 MB.");
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
    const response = await api.post<MediaAsset>("/media", { dataUrl, fileName: file.name, role });
    return response.data;
}

export async function archiveMediaAsset(id: string) {
    const response = await api.patch<MediaAsset>(`/media/${id}/archive`);
    return response.data;
}

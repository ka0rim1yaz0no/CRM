type ObjectUrlApi = Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;

export function createObjectUrlStore(blob: Blob | undefined, api: ObjectUrlApi = URL) {
    let value = "";
    const listeners = new Set<() => void>();
    return {
        getSnapshot: () => value,
        subscribe(listener: () => void) {
            listeners.add(listener);
            if (blob && !value) {
                value = api.createObjectURL(blob);
                listeners.forEach((notify) => notify());
            }
            return () => {
                listeners.delete(listener);
                if (!listeners.size && value) {
                    api.revokeObjectURL(value);
                    value = "";
                }
            };
        },
    };
}

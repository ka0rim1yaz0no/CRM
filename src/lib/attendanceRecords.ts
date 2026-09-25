import type { AttendanceRecord } from "../api/attendance";

export type OffPhoneAttendanceSession = {
    id: string;
    startedAt: string;
    endedAt: string | null;
    durationMs: number;
    isOpen: boolean;
    startRecord: AttendanceRecord;
    endRecord: AttendanceRecord | null;
};

function attendanceTimestamp(record?: AttendanceRecord | null) {
    const value = record?.timeIn || record?.createdAt;
    const timestamp = value ? new Date(value).getTime() : 0;
    return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function buildOffPhoneAttendanceSessions(
    records: AttendanceRecord[],
    fallbackEndAt = Date.now()
): OffPhoneAttendanceSession[] {
    const chronologicalRecords = [...records].sort(
        (first, second) => attendanceTimestamp(first) - attendanceTimestamp(second)
    );
    const sessions: OffPhoneAttendanceSession[] = [];
    let openRecord: AttendanceRecord | null = null;

    const closeOpenSession = (endRecord: AttendanceRecord | null, endTime: number, isOpen: boolean) => {
        if (!openRecord) {
            return;
        }

        const startedAt = attendanceTimestamp(openRecord);
        const safeEndTime = Math.max(startedAt, endTime);

        sessions.push({
            id: openRecord._id,
            startedAt: openRecord.timeIn,
            endedAt: endRecord?.timeIn || (isOpen ? null : new Date(safeEndTime).toISOString()),
            durationMs: Math.max(0, safeEndTime - startedAt),
            isOpen,
            startRecord: openRecord,
            endRecord,
        });
        openRecord = null;
    };

    chronologicalRecords.forEach((record) => {
        const recordTime = attendanceTimestamp(record);

        if (record.source === "Off the Phone Out") {
            if (openRecord) {
                closeOpenSession(record, recordTime, false);
            }
            openRecord = record;
            return;
        }

        if (record.source === "Off the Phone In" && openRecord) {
            closeOpenSession(record, recordTime, false);
            return;
        }

        if ((record.source === "Time Out" || record.source === "Logout") && openRecord) {
            closeOpenSession(record, recordTime, false);
        }
    });

    if (openRecord) {
        closeOpenSession(null, fallbackEndAt, true);
    }

    return sessions;
}

export function formatAttendanceDuration(milliseconds: number) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    }

    if (minutes > 0) {
        return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }

    return `${seconds}s`;
}

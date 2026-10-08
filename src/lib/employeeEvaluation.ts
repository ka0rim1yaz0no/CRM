import type { Employee } from "../api/employees";

const evaluationMonths = [1, 3, 6] as const;
const reminderLeadDays = 5;
const millisecondsPerDay = 24 * 60 * 60 * 1000;

export type EmployeeEvaluationReminder = {
    id: string;
    employeeId: string;
    employeeName: string;
    employeeCode: string;
    milestoneMonth: number;
    dueDate: Date;
    daysUntilDue: number;
};

export type EmployeeEvaluationSchedule = EmployeeEvaluationReminder;

function parseCalendarDate(value: string) {
    const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;

    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return Number.isNaN(date.getTime()) ? null : date;
}

function addCalendarMonths(value: Date, months: number) {
    const year = value.getUTCFullYear();
    const month = value.getUTCMonth() + months;
    const targetYear = year + Math.floor(month / 12);
    const targetMonth = ((month % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

    return new Date(Date.UTC(targetYear, targetMonth, Math.min(value.getUTCDate(), lastDay)));
}

function philippinesCalendarDate(now: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

    return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
}

export function getEmployeeEvaluationReminders(employees: Employee[], now = new Date()) {
    return getEmployeeEvaluationSchedule(employees, now).filter((item) => item.daysUntilDue >= 0 && item.daysUntilDue <= reminderLeadDays);
}

export function getEmployeeEvaluationSchedule(employees: Employee[], now = new Date()) {
    const today = philippinesCalendarDate(now);
    const reminders: EmployeeEvaluationReminder[] = [];

    employees.forEach((employee) => {
        if (employee.status === "Archived" || employee.terminationDate) return;

        const hireDate = parseCalendarDate(employee.dateHired);
        if (!hireDate) return;

        evaluationMonths.forEach((milestoneMonth) => {
            const dueDate = addCalendarMonths(hireDate, milestoneMonth);
            const daysUntilDue = Math.round((dueDate.getTime() - today.getTime()) / millisecondsPerDay);

            reminders.push({
                id: `${employee.employeeCode || employee._id}-${milestoneMonth}-${dueDate.toISOString().slice(0, 10)}`,
                employeeId: employee._id,
                employeeName: employee.name || "Employee",
                employeeCode: employee.employeeCode,
                milestoneMonth,
                dueDate,
                daysUntilDue,
            });
        });
    });

    return reminders.sort((first, second) =>
        first.dueDate.getTime() - second.dueDate.getTime() || first.employeeName.localeCompare(second.employeeName)
    );
}
